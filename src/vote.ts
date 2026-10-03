import {
  encodeFunctionData,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type FeeHistory,
  type Hex,
  type LocalAccount,
  type TransactionSerializableEIP1559,
} from "viem";
import { base } from "viem/chains";
import { moduleAbi } from "./abi.ts";
import { readMany, voterCall, type Chain, type Client } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import type { Vote } from "./select.ts";

const RECEIPT_TIMEOUT_MS = 60_000;
const BUSY = 0.5; // a pending block this full pays the tip of its 90th percentile

/** Failed after the transaction was sent: retrying would send another one. */
export class VoteSent extends Error {}

export type Nonces = { latest: number; pending: number };

export type Fees = { baseFee: bigint; tip: bigint; busy: bigint | undefined };

export type Tx = TransactionSerializableEIP1559 & {
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type Signed = { tx: Tx; signed: Hex };

const lastSentBy = new WeakMap<Client, Tx>();

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** The pending block's base fee and, when it is at least half full, the tip of its 90th percentile. */
export function feesFrom(history: FeeHistory, tip: bigint): Fees {
  const busy = (history.gasUsedRatio[0] ?? 0) >= BUSY ? history.reward?.[0]?.[0] : undefined;
  return { baseFee: history.baseFeePerGas[0] ?? 0n, tip, busy };
}

export const voteData = (vote: Vote) =>
  encodeFunctionData({ abi: moduleAbi, functionName: "vote", args: [vote.pools, vote.weights] });

/**
 * The transaction at `multiple` times the base fee, under the confirmed nonce so that a pending vote is replaced, not
 * queued behind: at a quarter more than the one this process sent, or at twice the fees over one of unknown fees.
 */
export function prepareVote(
  { client, module }: Chain,
  vote: Vote,
  gas: bigint,
  nonces: Nonces,
  fees: Fees,
  multiple = 2n,
): Tx {
  const tip = max(fees.tip, fees.busy ?? 0n);
  const lastSent = lastSentBy.get(client);
  const own = lastSent?.nonce === nonces.latest ? lastSent : undefined;
  const bump = (fee: bigint, sent?: bigint) =>
    sent !== undefined ? max(fee, (sent * 5n) / 4n) : nonces.pending > nonces.latest ? fee * 2n : fee;
  return {
    chainId: base.id,
    to: module,
    data: voteData(vote),
    gas,
    maxFeePerGas: bump(fees.baseFee * multiple + tip, own?.maxFeePerGas),
    maxPriorityFeePerGas: bump(tip, own?.maxPriorityFeePerGas),
    nonce: nonces.latest,
  };
}

/** Sends a signed transaction before `until` (ms); recorded first, as a send that fails may still have reached a node. */
export function sendVote({ client, broadcast }: Chain, { tx, signed }: Signed, until: number): Promise<Hex> {
  if (Date.now() >= until) return Promise.reject(new Error("out of time before sending"));
  lastSentBy.set(client, tx);
  return broadcast(signed, until);
}

/** Waits for the receipt, at most `timeout` ms, and verifies the Voter recorded the vote at that block. */
export async function confirmVote(
  chain: Chain,
  vote: Vote,
  hash: Hex,
  own: Set<Hex> = new Set([hash]),
  timeout = RECEIPT_TIMEOUT_MS,
): Promise<void> {
  const { client, conduit } = chain;
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
      throw new VoteSent(`vote ${hash}: outcome unknown: ${errorMessage(error)}`);
    }
    log.warning("receipt not seen in time; the Voter is re-checked later", { hash, timeout });
    return;
  }
  if (receipt.transactionHash !== hash) {
    if (own.has(receipt.transactionHash)) return log.info("vote replaced by a later one", { hash });
    throw new Error(`vote ${hash} was replaced by ${receipt.transactionHash}; sending again`);
  }
  if (receipt.status !== "success") throw new VoteSent(`vote ${hash} reverted`);
  const calls = [
    ...vote.pools.map((_, i) => voterCall(chain, "poolVote", [conduit, BigInt(i)])),
    ...vote.pools.map((pool) => voterCall(chain, "votes", [conduit, pool])),
  ];
  let recorded: (Address | bigint)[];
  try {
    recorded = await readMany<Address | bigint>(client, calls, { blockNumber: receipt.blockNumber });
  } catch (error) {
    throw new VoteSent(
      `vote ${hash} mined in block ${receipt.blockNumber}, verification failed: ${errorMessage(error)}`,
    );
  }
  const pools = recorded.slice(0, vote.pools.length) as Address[];
  if (pools.some((pool, i) => pool.toLowerCase() !== vote.pools[i]!.toLowerCase())) {
    throw new VoteSent(`vote ${hash}: Voter recorded ${pools.join(",")}, expected ${vote.pools.join(",")}`);
  }
  log.info("vote confirmed", { hash, block: receipt.blockNumber, pools, votes: recorded.slice(vote.pools.length) });
}

/** Simulates, signs and sends module.vote against the pending state; verifies it, waiting at most until `until` (ms). */
export async function castVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  until: number,
): Promise<void> {
  const { client, module, keeper } = chain;
  const data = voteData(vote);
  const args = [vote.pools, vote.weights] as const;
  const [gas, history, tip, latest, pending, balance, l1Fee] = await allOrFirstFailure([
    client.simulateContract({
      address: module,
      abi: moduleAbi,
      functionName: "vote",
      args,
      account: keeper,
      blockTag: "pending",
    }),
    client.estimateGas({ account: keeper, to: module, data, blockTag: "pending" }),
    client.getFeeHistory({ blockCount: 1, blockTag: "pending", rewardPercentiles: [90] }),
    client.estimateMaxPriorityFeePerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "latest" }),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }),
    client.getBalance({ address: keeper }),
    client.estimateL1Fee({ account: keeper, to: module, data }),
  ]).then(([, ...rest]) => rest);
  const tx = prepareVote(chain, vote, (gas * 12n) / 10n, { latest, pending }, feesFrom(history, tip));
  const cost = tx.gas * tx.maxFeePerGas + l1Fee;
  if (balance < 2n * cost) throw new Error(`fund the keeper: ${keeper} has ${balance} wei, a vote costs up to ${cost}`);
  log.info("vote prepared", { pools: vote.pools, weights: vote.weights, gas: tx.gas, nonce: tx.nonce });

  if (!account) {
    log.warning("signing skipped: no KMS key configured");
    return;
  }
  let signed: Hex;
  try {
    signed = await account.signTransaction(tx);
  } catch (error) {
    if (dryRun && error instanceof NoMetadataServer) {
      log.warning("signing skipped: no metadata server", { reason: error.message });
      return;
    }
    throw error;
  }
  if (dryRun) {
    log.info("dry run: signed, not sent");
    return;
  }
  const hash = await sendVote(chain, { tx, signed }, until);
  log.info("vote sent", { hash });
  await confirmVote(chain, vote, hash, undefined, Math.max(1, Math.min(RECEIPT_TIMEOUT_MS, until - Date.now())));
}

type Promises<T extends readonly unknown[]> = { [K in keyof T]: Promise<T[K]> };

/** Like Promise.all, but the rejection reported is the earliest in the list, not the earliest in time. */
export async function allOrFirstFailure<T extends readonly unknown[]>(promises: Promises<T>): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

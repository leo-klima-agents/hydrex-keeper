import {
  encodeFunctionData,
  parseGwei,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { base } from "viem/chains";
import { moduleAbi } from "./abi.ts";
import { readMany, voterCall, type Chain, type Client } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import type { Vote } from "./select.ts";

const RECEIPT_TIMEOUT_MS = 60_000;
const CONGESTED = 0.9; // in a block this full, the builder picks by tip
const TIP_PERCENTILE = 99;
const MAX_TIP = parseGwei("0.1");
const MAX_GAS = 16_777_216n; // per transaction on Base, since its Azul upgrade

/** Failed after the transaction was sent: retrying would send another one. */
export class VoteSent extends Error {}

type Tx = {
  chainId: number;
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
};

/** The block a vote is for: its timestamp (s), and the conduit's `lastVoted` as read on it. */
type Target = { time: bigint; lastVoted: bigint };

export type Prepared = { tx: Tx; signed?: Hex | undefined; lastVoted?: bigint | undefined };

const lastSentBy = new WeakMap<Client, Tx & { lastVoted?: bigint | undefined }>();

/**
 * Simulates module.vote just after the block it is for, by default the latest, and signs it unless there is no key.
 * The max fee is twice the base fee plus the tip; if either of the last two blocks was congested, the tip rises to the
 * 99th percentile of their tips, up to MAX_TIP.
 */
export async function prepareVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  target?: Target,
): Promise<Prepared> {
  const { client, module, keeper } = chain;
  const args = [vote.pools, vote.weights] as const;
  const data = encodeFunctionData({ abi: moduleAbi, functionName: "vote", args });
  const call = { account: keeper, to: module, abi: moduleAbi, functionName: "vote", args } as const;
  const time = target?.time ?? (await client.getBlock()).timestamp;
  // The simulated block builds on the latest one, which may already be the one at `time`.
  const blockOverrides = { time: time + 1n };
  const [[block], suggested, history, latest, pending, balance, l1Fee] = await allOrFirstFailure([
    client.simulateBlocks({ blocks: [{ blockOverrides, calls: [call] }] }),
    client.estimateMaxPriorityFeePerGas(),
    client.getFeeHistory({ blockCount: 2, rewardPercentiles: [TIP_PERCENTILE] }),
    client.getTransactionCount({ address: keeper, blockTag: "latest" }),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }),
    client.getBalance({ address: keeper, blockTag: "pending" }),
    client.estimateL1Fee({ account: keeper, to: module, data }),
  ]);
  const simulated = block!.calls[0]!;
  if (simulated.status !== "success") throw simulated.error ?? new Error("the vote would revert");
  const baseFee = history.baseFeePerGas.at(-1); // the next block's
  if (baseFee === undefined) throw new Error("no base fee");
  const congested = history.gasUsedRatio.some((ratio) => ratio >= CONGESTED);
  const top = (history.reward ?? []).reduce((a, [reward]) => max(a, reward ?? 0n), 0n);
  const tip = congested ? max(suggested, min(top, MAX_TIP)) : suggested;
  // The confirmed nonce, so that a pending vote is replaced, not queued behind: at a quarter more than the one this
  // process sent, or at twice the fees over one of unknown fees. Once the Voter shows a later vote than the one the sent
  // vote was decided on, that vote is in a block, whatever the node says.
  const lastSent = lastSentBy.get(client);
  const mined = target && lastSent?.lastVoted !== undefined && target.lastVoted > lastSent.lastVoted;
  const nonce = Math.max(latest, mined ? lastSent.nonce + 1 : 0);
  const queued = pending > nonce;
  const own = lastSent?.nonce === nonce ? lastSent : undefined;
  const bump = (fee: bigint, sent?: bigint) =>
    sent !== undefined ? max(fee, (sent * 5n) / 4n) : queued ? fee * 2n : fee;
  const tx = {
    chainId: base.id,
    to: module,
    data,
    // Refunds and the 63/64 rule make the gas needed exceed the gas used, by up to about a third.
    gas: min((simulated.gasUsed * 3n) / 2n, MAX_GAS),
    maxFeePerGas: bump(2n * baseFee + tip, own?.maxFeePerGas),
    maxPriorityFeePerGas: bump(tip, own?.maxPriorityFeePerGas),
    nonce,
  } satisfies Tx;
  const cost = tx.gas * tx.maxFeePerGas + l1Fee;
  if (balance < 2n * cost) throw new Error(`fund the keeper: ${keeper} has ${balance} wei, a vote costs up to ${cost}`);
  log.info("vote prepared", { pools: vote.pools, weights: vote.weights, gas: tx.gas, nonce, tip, congested });

  const lastVoted = target?.lastVoted;
  if (!account) {
    log.warning("signing skipped: no KMS key configured");
    return { tx, lastVoted };
  }
  try {
    return { tx, signed: await account.signTransaction(tx), lastVoted };
  } catch (error) {
    if (dryRun && error instanceof NoMetadataServer) {
      log.warning("signing skipped: no metadata server", { reason: error.message });
      return { tx, lastVoted };
    }
    throw error;
  }
}

/** Sends a signed vote to every RPC; resolves with its hash once one accepts it before `until` (ms). */
export async function broadcastVote(
  chain: Chain,
  { tx, signed, lastVoted }: Prepared & { signed: Hex },
  until: number,
): Promise<Hex> {
  if (Date.now() >= until) throw new Error("out of time before sending");
  lastSentBy.set(chain.client, { ...tx, lastVoted }); // before sending: a send that fails may still have reached a node
  return chain.broadcast(signed, until);
}

/** Prepares and sends module.vote; verifies the Voter recorded it, waiting at most until `until` (ms). */
export async function castVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  until: number,
): Promise<void> {
  const prepared = await prepareVote(chain, account, vote, dryRun);
  const { signed } = prepared;
  if (!signed) return;
  if (dryRun) {
    log.info("dry run: signed, not sent");
    return;
  }
  const hash = await broadcastVote(chain, { ...prepared, signed }, until);
  log.info("vote sent", { hash });
  const timeout = Math.max(1, Math.min(RECEIPT_TIMEOUT_MS, until - Date.now()));
  let receipt;
  try {
    // Base RPCs return receipts from the block being built, which cannot be read yet; one block on top seals it.
    receipt = await chain.client.waitForTransactionReceipt({ hash, timeout, confirmations: 2 });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
      throw new VoteSent(`vote ${hash}: outcome unknown: ${errorMessage(error)}`);
    }
    log.warning("receipt not seen in time; the next pass re-checks the Voter", { hash, timeout });
    return;
  }
  if (receipt.transactionHash !== hash) {
    throw new Error(`vote ${hash} was replaced by ${receipt.transactionHash}; sending again`);
  }
  if (receipt.status !== "success") throw new VoteSent(`vote ${hash} reverted`);
  await verifyVote(chain, vote, hash, receipt.blockNumber);
}

/** Checks that the Voter recorded `vote` as of block `blockNumber`. */
export async function verifyVote(chain: Chain, vote: Vote, hash: Hex, blockNumber: bigint): Promise<void> {
  const calls = [
    ...vote.pools.map((_, i) => voterCall(chain, "poolVote", [chain.conduit, BigInt(i)])),
    ...vote.pools.map((pool) => voterCall(chain, "votes", [chain.conduit, pool])),
  ];
  let recorded: (Address | bigint)[];
  try {
    recorded = await readMany<Address | bigint>(chain.client, calls, { blockNumber });
  } catch (error) {
    throw new VoteSent(`vote ${hash} mined in block ${blockNumber}, verification failed: ${errorMessage(error)}`);
  }
  const pools = recorded.slice(0, vote.pools.length) as Address[];
  if (pools.some((pool, i) => pool.toLowerCase() !== vote.pools[i]!.toLowerCase())) {
    throw new VoteSent(`vote ${hash}: Voter recorded ${pools.join(",")}, expected ${vote.pools.join(",")}`);
  }
  log.info("vote confirmed", { hash, block: blockNumber, pools, votes: recorded.slice(vote.pools.length) });
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

type Promises<T extends readonly unknown[]> = { [K in keyof T]: Promise<T[K]> };

/** Like Promise.all, but the rejection reported is the earliest in the list, not the earliest in time. */
async function allOrFirstFailure<T extends readonly unknown[]>(promises: Promises<T>): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

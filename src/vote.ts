import {
  encodeFunctionData,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionSerializableEIP1559,
} from "viem";
import { base } from "viem/chains";
import { moduleAbi } from "./abi.ts";
import { readMany, voterCall, type Chain, type Client } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { describe, log } from "./log.ts";
import type { Vote } from "./select.ts";

const RECEIPT_TIMEOUT = 60_000;

/** Failed after the transaction was sent: retrying would send another one. */
export class VoteSent extends Error {}

const lastSentBy = new WeakMap<Client, { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>();

/** Simulates, signs and sends module.vote; verifies the Voter recorded it, waiting at most until `until` (ms). */
export async function castVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  until: number,
): Promise<void> {
  const { client, module, keeper, conduit } = chain;
  const args = [vote.pools, vote.weights] as const;
  const data = encodeFunctionData({ abi: moduleAbi, functionName: "vote", args });
  const [gas, fees, latest, pending, balance, l1Fee] = await allOrFirstFailure([
    client.simulateContract({ address: module, abi: moduleAbi, functionName: "vote", args, account: keeper }),
    client.estimateGas({ account: keeper, to: module, data }),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "latest" }),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }),
    client.getBalance({ address: keeper }),
    client.estimateL1Fee({ account: keeper, to: module, data }),
  ]).then(([, ...rest]) => rest);
  // A pending vote this process sent is replaced at a quarter higher fees; one of unknown fees is queued behind.
  const lastSent = lastSentBy.get(client);
  const nonce = pending > latest && lastSent?.nonce !== latest ? pending : latest;
  const floor = lastSent?.nonce === nonce ? lastSent : { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n };
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const tx: TransactionSerializableEIP1559 = {
    chainId: base.id,
    to: module,
    data,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: max(fees.maxFeePerGas, (floor.maxFeePerGas * 5n) / 4n),
    maxPriorityFeePerGas: max(fees.maxPriorityFeePerGas, (floor.maxPriorityFeePerGas * 5n) / 4n),
    nonce,
  };
  const cost = tx.gas! * tx.maxFeePerGas! + l1Fee;
  if (balance < 2n * cost) throw new Error(`fund the keeper: ${keeper} has ${balance} wei, a vote costs up to ${cost}`);
  log.info("vote prepared", { pools: vote.pools, weights: vote.weights, gas: tx.gas, nonce });

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

  if (Date.now() >= until) throw new Error("out of time before sending");
  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  lastSentBy.set(client, { nonce, maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas! });
  log.info("vote sent", { hash });
  const timeout = Math.max(1, Math.min(RECEIPT_TIMEOUT, until - Date.now()));
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
      throw new VoteSent(`vote ${hash}: outcome unknown: ${describe(error)}`);
    }
    log.warning("receipt not seen in time; the next pass re-checks the Voter", { hash, timeout });
    return;
  }
  if (receipt.transactionHash !== hash) {
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
    throw new VoteSent(`vote ${hash} mined in block ${receipt.blockNumber}, verification failed: ${describe(error)}`);
  }
  const pools = recorded.slice(0, vote.pools.length) as Address[];
  if (pools.some((pool, i) => pool.toLowerCase() !== vote.pools[i]!.toLowerCase())) {
    throw new VoteSent(`vote ${hash}: Voter recorded ${pools.join(",")}, expected ${vote.pools.join(",")}`);
  }
  log.info("vote confirmed", { hash, block: receipt.blockNumber, pools, votes: recorded.slice(vote.pools.length) });
}

type Promises<T extends readonly unknown[]> = { [K in keyof T]: Promise<T[K]> };

/** Like Promise.all, but the rejection reported is the earliest in the list, not the earliest in time. */
async function allOrFirstFailure<T extends readonly unknown[]>(promises: Promises<T>): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

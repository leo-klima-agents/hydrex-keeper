import { encodeFunctionData, WaitForTransactionReceiptTimeoutError, type Address, type LocalAccount, type TransactionSerializableEIP1559 } from "viem";
import { base } from "viem/chains";
import { moduleAbi, voterAbi } from "./abi.ts";
import { readMany, type Chain, type Client } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { log } from "./log.ts";
import type { Vote } from "./select.ts";

const RECEIPT_TIMEOUT = 60_000;

/** Failed after the transaction was sent: retrying would send another one. */
export class VoteSent extends Error {}

/** Whether the Voter already holds `desired` for `power`, pool by pool and with the weights the Voter would derive. */
export function sameVote(current: { pools: Address[]; votes: bigint[] }, desired: Vote, power: bigint): boolean {
  const total = desired.weights.reduce((a, b) => a + b, 0n);
  return (
    current.pools.length === desired.pools.length &&
    current.pools.every(
      (pool, i) =>
        pool.toLowerCase() === desired.pools[i]!.toLowerCase() && current.votes[i] === (desired.weights[i]! * power) / total,
    )
  );
}

const lastSentBy = new WeakMap<Client, { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>();

/** Simulates, signs and sends module.vote; verifies the Voter recorded it, waiting at most until `until` (ms). */
export async function castVote(chain: Chain, account: LocalAccount | undefined, vote: Vote, dryRun: boolean, until: bigint): Promise<void> {
  const { client, module, keeper, voter, conduit } = chain;
  const args = [vote.pools, vote.weights] as const;
  const data = encodeFunctionData({ abi: moduleAbi, functionName: "vote", args });
  const [gas, fees, nonce, balance, l1Fee] = await allOrFirstFailure([
    client.simulateContract({ address: module, abi: moduleAbi, functionName: "vote", args, account: keeper }),
    client.estimateGas({ account: keeper, to: module, data }),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "latest" }),
    client.getBalance({ address: keeper }),
    client.estimateL1Fee({ account: keeper, to: module, data }),
  ]).then(([, ...rest]) => rest);
  // A vote still pending under the same nonce is replaced by paying a quarter more than it did.
  const lastSent = lastSentBy.get(client);
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
  let signed: `0x${string}`;
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

  if (BigInt(Date.now()) >= until) throw new Error("out of time before sending");
  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  lastSentBy.set(client, { nonce, maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas! });
  log.info("vote sent", { hash });
  const timeout = Math.max(1, Math.min(RECEIPT_TIMEOUT, Number(until - BigInt(Date.now()))));
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) throw error;
    log.warning("receipt not seen in time; the next pass re-checks the Voter", { hash, timeout });
    return;
  }
  if (receipt.status !== "success") throw new VoteSent(`vote ${hash} reverted`);
  const recorded = await readMany<Address | bigint>(
    client,
    [
      ...vote.pools.map((_, i) => ({ address: voter, abi: voterAbi, functionName: "poolVote", args: [conduit, BigInt(i)] })),
      ...vote.pools.map((pool) => ({ address: voter, abi: voterAbi, functionName: "votes", args: [conduit, pool] })),
    ],
    { blockNumber: receipt.blockNumber },
  );
  const pools = recorded.slice(0, vote.pools.length) as Address[];
  if (pools.some((pool, i) => pool.toLowerCase() !== vote.pools[i]!.toLowerCase())) {
    throw new VoteSent(`vote ${hash}: Voter recorded ${pools.join(",")}, expected ${vote.pools.join(",")}`);
  }
  log.info("vote confirmed", { hash, block: receipt.blockNumber, pools, votes: recorded.slice(vote.pools.length) });
}

/** Like Promise.all, but the rejection reported is the earliest in the list, not the earliest in time. */
async function allOrFirstFailure<T extends readonly unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

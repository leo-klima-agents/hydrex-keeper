import { encodeFunctionData, type Address, type LocalAccount, type TransactionSerializableEIP1559 } from "viem";
import { base } from "viem/chains";
import { moduleAbi, voterAbi } from "./abi.ts";
import { readMany, type Chain } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { log } from "./log.ts";
import type { Vote } from "./select.ts";

const RECEIPT_TIMEOUT = 60_000;

export function sameVote(current: Address[], desired: Vote): boolean {
  return (
    current.length === desired.pools.length &&
    current.every((pool, i) => pool.toLowerCase() === desired.pools[i]!.toLowerCase())
  );
}

/** Simulates, signs and sends module.vote; verifies the Voter recorded it. */
export async function castVote(chain: Chain, account: LocalAccount | undefined, vote: Vote, dryRun: boolean): Promise<void> {
  const { client, module, keeper, voter, conduit } = chain;
  const args = [vote.pools, vote.weights] as const;
  const data = encodeFunctionData({ abi: moduleAbi, functionName: "vote", args });
  const [gas, fees, nonce, balance, l1Fee] = await allOrFirstFailure([
    client.simulateContract({ address: module, abi: moduleAbi, functionName: "vote", args, account: keeper }),
    client.estimateGas({ account: keeper, to: module, data }),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }),
    client.getBalance({ address: keeper }),
    client.estimateL1Fee({ account: keeper, to: module, data }),
  ]).then(([, ...rest]) => rest);
  const tx: TransactionSerializableEIP1559 = {
    chainId: base.id,
    to: module,
    data,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
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

  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  log.info("vote sent", { hash });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT });
  if (receipt.status !== "success") throw new Error(`vote ${hash} reverted`);
  const recorded = await readMany<Address | bigint>(
    client,
    [
      ...vote.pools.map((_, i) => ({ address: voter, abi: voterAbi, functionName: "poolVote", args: [conduit, BigInt(i)] })),
      ...vote.pools.map((pool) => ({ address: voter, abi: voterAbi, functionName: "votes", args: [conduit, pool] })),
    ],
    { blockNumber: receipt.blockNumber },
  );
  const pools = recorded.slice(0, vote.pools.length) as Address[];
  if (!sameVote(pools, vote)) throw new Error(`Voter recorded ${pools.join(",")}, expected ${vote.pools.join(",")}`);
  log.info("vote confirmed", { hash, block: receipt.blockNumber, pools, votes: recorded.slice(vote.pools.length) });
}

/** Like Promise.all, but the rejection reported is the earliest in the list, not the earliest in time. */
async function allOrFirstFailure<T extends readonly unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

import type { Address } from "viem";
import { bribeAbi, erc20Abi, veAbi, voterAbi } from "./abi.ts";
import { readMany, WEEK, type Chain } from "./chain.ts";

/** `currentVote` is empty unless the conduit voted in this epoch: votes do not carry over. */
export type Epoch = { start: bigint; flip: bigint; power: bigint; votedThisEpoch: boolean; currentVote: Address[] };

export type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; alive: boolean; otherVotes: bigint; rewards: Reward[] };

type Slot = { pool: number; bribe: Address; token: Address; decimals: number };

/** What does not change within an epoch: gauges, bribe contracts, their reward tokens. */
export type Static = { pools: Address[]; gauges: Address[]; slots: Slot[] };

/** Current epoch, the conduit's power in it and the pools it currently votes for. */
export async function readEpoch(chain: Chain): Promise<Epoch> {
  const { client, voter, ve, conduit } = chain;
  const [start, lastVoted, poolVoteLength] = (await readMany<bigint>(client, [
    { address: voter, abi: voterAbi, functionName: "_epochTimestamp" },
    { address: voter, abi: voterAbi, functionName: "lastVoted", args: [conduit] },
    { address: voter, abi: voterAbi, functionName: "poolVoteLength", args: [conduit] },
  ])) as [bigint, bigint, bigint];
  const votedThisEpoch = lastVoted >= start;
  const [power, ...currentVote] = await readMany<bigint | Address>(client, [
    { address: ve, abi: veAbi, functionName: "getPastVotes", args: [conduit, start] },
    ...Array.from({ length: votedThisEpoch ? Number(poolVoteLength) : 0 }, (_, i) => ({
      address: voter,
      abi: voterAbi,
      functionName: "poolVote",
      args: [conduit, BigInt(i)],
    })),
  ]);
  return { start, flip: start + WEEK, power: power as bigint, votedThisEpoch, currentVote: currentVote as Address[] };
}

export async function readStatic(chain: Chain, pools: Address[]): Promise<Static> {
  const { client, voter } = chain;
  const v = (functionName: string, args: readonly unknown[]) => ({ address: voter, abi: voterAbi, functionName, args });

  const gauges = await readMany<Address>(client, pools.map((pool) => v("gauges", [pool])));
  const bribes = await readMany<Address>(
    client,
    gauges.flatMap((gauge) => [v("external_bribes", [gauge]), v("internal_bribes", [gauge])]),
  );
  const lengths = await readMany<bigint>(
    client,
    bribes.map((address) => ({ address, abi: bribeAbi, functionName: "rewardsListLength" })),
  );
  const slots = bribes.flatMap((bribe, b) =>
    Array.from({ length: Number(lengths[b]) }, (_, j) => ({ pool: b >> 1, bribe, index: BigInt(j) })),
  );
  const tokens = await readMany<Address>(
    client,
    slots.map((s) => ({ address: s.bribe, abi: bribeAbi, functionName: "rewardTokens", args: [s.index] })),
  );
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  const decimals = await readMany<number>(
    client,
    distinct.map((address) => ({ address, abi: erc20Abi, functionName: "decimals" })),
  );
  const decimalsOf = new Map(distinct.map((t, i) => [t, decimals[i]!]));
  return {
    pools,
    gauges,
    slots: slots.map((s, k) => ({ pool: s.pool, bribe: s.bribe, token: tokens[k]!, decimals: decimalsOf.get(tokens[k]!.toLowerCase() as Address)! })),
  };
}

/** This epoch's bribes and fees per pool, and the votes each pool has from others. */
export async function readRewards(chain: Chain, { pools, gauges, slots }: Static, epoch: Epoch): Promise<PoolRewards[]> {
  const { client, voter, conduit } = chain;
  const v = (functionName: string, args: readonly unknown[]) => ({ address: voter, abi: voterAbi, functionName, args });

  const results = await readMany<boolean | bigint | [bigint, bigint, bigint]>(client, [
    ...gauges.flatMap((gauge, i) => [v("isAlive", [gauge]), v("weights", [pools[i]]), v("votes", [conduit, pools[i]])]),
    ...slots.map((s) => ({ address: s.bribe, abi: bribeAbi, functionName: "rewardData", args: [s.token, epoch.start] })),
  ]);
  const perPool = results.slice(0, 3 * pools.length);
  const data = results.slice(3 * pools.length) as [bigint, bigint, bigint][];

  return pools.map((pool, i) => ({
    pool,
    alive: perPool[3 * i] as boolean,
    // Voter.votes keeps last epoch's figure until the next vote resets it.
    otherVotes: (perPool[3 * i + 1] as bigint) - (epoch.votedThisEpoch ? (perPool[3 * i + 2] as bigint) : 0n),
    rewards: slots.flatMap((s, k) => (s.pool === i && data[k]![1] > 0n ? [{ token: s.token, amount: data[k]![1], decimals: s.decimals }] : [])),
  }));
}

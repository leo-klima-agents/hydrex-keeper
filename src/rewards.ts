import { zeroAddress, type Address } from "viem";
import { bribeAbi, erc20Abi, veAbi, voterAbi } from "./abi.ts";
import { readMany, WEEK, type Chain } from "./chain.ts";
import { log } from "./log.ts";

/** `currentVote` is empty unless the conduit voted in this epoch: votes do not carry over. */
export type Epoch = { start: bigint; flip: bigint; power: bigint; votedThisEpoch: boolean; currentVote: { pools: Address[]; votes: bigint[] } };

export type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; alive: boolean; otherVotes: bigint; rewards: Reward[] };

type Slot = { pool: number; bribe: Address; token: Address; decimals: number };

/** What rarely changes within an epoch: gauges, bribe contracts, their reward tokens. */
export type Static = { pools: Address[]; gauges: Address[]; bribes: Address[]; lengths: bigint[]; slots: Slot[] };

/** A bribe contract gained a reward token since `readStatic`. */
export class StaticChanged extends Error {}

/**
 * Current epoch, the conduit's power in it and the pools it currently votes for, at most `maxPools` of them
 * (a longer list reads as a different vote). Power is read at the calendar epoch; `assertFresh` in main.ts
 * makes that the Voter's epoch before it is used.
 */
export async function readEpoch(chain: Chain, maxPools: number): Promise<Epoch> {
  const { client, voter, ve, conduit } = chain;
  const calendar = (BigInt(Math.floor(Date.now() / 1000)) / WEEK) * WEEK;
  const [start, lastVoted, poolVoteLength, power, ...listed] = await readMany<bigint | Address | undefined>(
    client,
    [
      { address: voter, abi: voterAbi, functionName: "_epochTimestamp" },
      { address: voter, abi: voterAbi, functionName: "lastVoted", args: [conduit] },
      { address: voter, abi: voterAbi, functionName: "poolVoteLength", args: [conduit] },
      { address: ve, abi: veAbi, functionName: "getPastVotes", args: [conduit, calendar] },
      ...Array.from({ length: maxPools }, (_, i) => ({ address: voter, abi: voterAbi, functionName: "poolVote", args: [conduit, BigInt(i)] })),
    ],
    { lenient: true },
  );
  if (start === undefined || lastVoted === undefined || poolVoteLength === undefined || power === undefined) throw new Error("cannot read the epoch");
  const votedThisEpoch = (lastVoted as bigint) >= (start as bigint);
  const pools = (votedThisEpoch ? listed.slice(0, Number(poolVoteLength)) : []) as Address[];
  if (pools.some((pool) => pool === undefined)) throw new Error("cannot read the current vote");
  const votes = await readMany<bigint>(
    client,
    pools.map((pool) => ({ address: voter, abi: voterAbi, functionName: "votes", args: [conduit, pool] })),
  );
  return { start: start as bigint, flip: (start as bigint) + WEEK, power: power as bigint, votedThisEpoch, currentVote: { pools, votes } };
}

export async function readStatic(chain: Chain, whitelist: Address[]): Promise<Static> {
  const { client, voter } = chain;
  const v = (functionName: string, args: readonly unknown[]) => ({ address: voter, abi: voterAbi, functionName, args });

  const allGauges = await readMany<Address>(client, whitelist.map((pool) => v("gauges", [pool])));
  const missing = whitelist.filter((_, i) => allGauges[i] === zeroAddress);
  if (missing.length) log.warning("no gauge, skipping", { pools: missing });
  const pools = whitelist.filter((_, i) => allGauges[i] !== zeroAddress);
  const gauges = allGauges.filter((gauge) => gauge !== zeroAddress);

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
  const decimals = await readMany<number | undefined>(
    client,
    distinct.map((address) => ({ address, abi: erc20Abi, functionName: "decimals" })),
    { lenient: true },
  );
  const decimalsOf = new Map(distinct.map((t, i) => [t, decimals[i] ?? 18]));
  return {
    pools,
    gauges,
    bribes,
    lengths,
    slots: slots.map((s, k) => ({ pool: s.pool, bribe: s.bribe, token: tokens[k]!, decimals: decimalsOf.get(tokens[k]!.toLowerCase() as Address)! })),
  };
}

/** This epoch's bribes and fees per pool, and the votes each pool has from others. */
export async function readRewards(chain: Chain, { pools, gauges, bribes, lengths, slots }: Static, epoch: Epoch): Promise<PoolRewards[]> {
  const { client, voter, conduit } = chain;
  const v = (functionName: string, args: readonly unknown[]) => ({ address: voter, abi: voterAbi, functionName, args });

  const results = await readMany<boolean | bigint | [bigint, bigint, bigint]>(client, [
    ...bribes.map((address) => ({ address, abi: bribeAbi, functionName: "rewardsListLength" })),
    ...gauges.flatMap((gauge, i) => [v("isAlive", [gauge]), v("weights", [pools[i]]), v("votes", [conduit, pools[i]])]),
    ...slots.map((s) => ({ address: s.bribe, abi: bribeAbi, functionName: "rewardData", args: [s.token, epoch.start] })),
  ]);
  if (lengths.some((length, b) => results[b] !== length)) throw new StaticChanged("reward tokens changed");
  const perPool = results.slice(bribes.length, bribes.length + 3 * pools.length);
  const data = results.slice(bribes.length + 3 * pools.length) as [bigint, bigint, bigint][];

  return pools.map((pool, i) => ({
    pool,
    alive: perPool[3 * i] as boolean,
    // Voter.votes keeps last epoch's figure until the next vote resets it.
    otherVotes: (perPool[3 * i + 1] as bigint) - (epoch.votedThisEpoch ? (perPool[3 * i + 2] as bigint) : 0n),
    rewards: slots.flatMap((s, k) => (s.pool === i && data[k]![1] > 0n ? [{ token: s.token, amount: data[k]![1], decimals: s.decimals }] : [])),
  }));
}

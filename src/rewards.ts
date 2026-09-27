import { zeroAddress, type Address } from "viem";
import { bribeAbi, erc20Abi, veAbi, voterAbi } from "./abi.ts";
import { readMany, WEEK, type Chain } from "./chain.ts";
import { log } from "./log.ts";

export type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; alive: boolean; otherVotes: bigint; rewards: Reward[] };

export type Slot = { pool: number; bribe: Address; token: Address; decimals: number };

/** What rarely changes within an epoch: gauges, bribe contracts, their reward tokens. */
export type Static = { pools: Address[]; gauges: Address[]; bribes: Address[]; lengths: bigint[]; slots: Slot[] };

/**
 * What a pass reads. `voterStart` is the Voter's epoch, for the caller to check against the calendar epoch the reads
 * used. `currentVote` is empty unless the conduit voted in this epoch: votes do not carry over.
 */
export type State = { voterStart: bigint; power: bigint; currentVote: { pools: Address[]; votes: bigint[] }; pools: PoolRewards[] };

/** A bribe contract gained a reward token since `readStatic`. */
export class StaticChanged extends Error {}

/** The Voter's epoch start and the flip that ends it. */
export async function readEpoch(chain: Chain): Promise<{ start: bigint; flip: bigint }> {
  const [start] = await readMany<bigint>(chain.client, [{ address: chain.voter, abi: voterAbi, functionName: "_epochTimestamp" }]);
  return { start: start!, flip: start! + WEEK };
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

/**
 * A pass's reads: the Voter's epoch, the conduit's power and votes, whether a bribe contract gained a reward token
 * since `readStatic` (StaticChanged), and per pool its liveness, weight and this epoch's rewards (`start` is the
 * calendar epoch). Everything but the rewards comes first, within one eth_call and so one block (see MAX_POOLS).
 */
export async function readState(chain: Chain, s: Static, start: bigint): Promise<State> {
  const { client, voter, ve, conduit } = chain;
  const v = (functionName: string, args: readonly unknown[]) => ({ address: voter, abi: voterAbi, functionName, args });
  const results = await readMany<bigint | boolean | [bigint, bigint, bigint]>(client, [
    v("_epochTimestamp", []),
    v("lastVoted", [conduit]),
    { address: ve, abi: veAbi, functionName: "getPastVotes", args: [conduit, start] },
    ...s.bribes.map((address) => ({ address, abi: bribeAbi, functionName: "rewardsListLength" })),
    ...s.gauges.flatMap((gauge, i) => [v("isAlive", [gauge]), v("weights", [s.pools[i]]), v("votes", [conduit, s.pools[i]])]),
    ...s.slots.map((slot) => ({ address: slot.bribe, abi: bribeAbi, functionName: "rewardData", args: [slot.token, start] })),
  ]);
  const [voterStart, lastVoted, power] = results as bigint[];
  if (s.bribes.some((_, b) => results[3 + b] !== s.lengths[b])) throw new StaticChanged("reward tokens changed");
  const perPool = results.slice(3 + s.bribes.length, 3 + s.bribes.length + 3 * s.pools.length);
  const amounts = (results.slice(3 + s.bribes.length + 3 * s.pools.length) as [bigint, bigint, bigint][]).map((d) => d[1]);
  // Voter.votes keeps last epoch's figure until the next vote resets it.
  const own = s.pools.map((_, i) => (lastVoted! >= voterStart! ? (perPool[3 * i + 2] as bigint) : 0n));
  const voted = s.pools.flatMap((pool, i) => (own[i]! > 0n ? [i] : []));
  return {
    voterStart: voterStart!,
    power: power!,
    currentVote: { pools: voted.map((i) => s.pools[i]!), votes: voted.map((i) => own[i]!) },
    pools: s.pools.map((pool, i) => ({
      pool,
      alive: perPool[3 * i] as boolean,
      otherVotes: (perPool[3 * i + 1] as bigint) - own[i]!,
      rewards: s.slots.flatMap((slot, k) => (slot.pool === i && amounts[k]! > 0n ? [{ token: slot.token, amount: amounts[k]!, decimals: slot.decimals }] : [])),
    })),
  };
}

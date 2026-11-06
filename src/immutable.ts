import type { Address } from "viem";
import { immutableAbi } from "./abi.ts";
import { call, lower, readMany, type Chain, type Client } from "./chain.ts";
import { warnOnce } from "./log.ts";
import type { PoolRewards, State } from "./read.ts";
import {
  asVoted,
  gain,
  MIN_GAIN_USD,
  proportional,
  score,
  select,
  summarize,
  toVote,
  waterFillAbove,
  type Candidate,
  type Vote,
} from "./select.ts";

// The immutable conduit lets anyone propose its vote. It only accepts a vote whose score,
// counted in the tokens it prices with Chainlink, beats the vote in force by MIN_GAIN. The job picks votes at its own
// prices and checks the conduit's score before sending.
const MAX_IMMUTABLE_POOLS = 20; // the conduit's MAX_POOLS
const MIN_GAIN = 1; // USD, the conduit's MIN_GAIN
const MARGIN = 0.1; // USD above MIN_GAIN, in case other votes move before ours lands
const VALUE_CHUNK = 25; // poolValue calls per eth_call, because each can use 200k gas
const VALUE_CONCURRENCY = 3; // kept low because these reads repeat every block, on the RPCs the votes use

/** `current` is the conduit's score of the vote in force, in USD. */
export type Onchain = { values: Map<Address, number>; current: number };

export type ImmutableDecision = { vote: Vote | null; note: string; votes: bigint[]; summary: Record<string, unknown> };

const immutableCall = (conduit: Address, functionName: string, args?: readonly unknown[]) =>
  call(conduit, immutableAbi, functionName, args);

const usd = (wad: bigint) => Number(wad) / 1e18;

export function pricedPools(pools: PoolRewards[], priced: Address[]): Address[] {
  const tokens = new Set(priced.map(lower));
  return pools.filter((p) => p.rewards.some((r) => tokens.has(lower(r.token)))).map((p) => p.pool);
}

/** Fails while the conduit can't vote. */
export async function readValues(
  { immutable }: Chain,
  client: Client,
  pools: Address[],
): Promise<Map<Address, number>> {
  const calls = pools.map((pool) => immutableCall(immutable.conduit, "poolValue", [pool]));
  const values = await readMany<bigint>(client, calls, { chunk: VALUE_CHUNK, concurrency: VALUE_CONCURRENCY });
  return new Map(pools.map((pool, i) => [lower(pool), usd(values[i]!)]));
}

/** For a score the conduit couldn't give with the votes: warns once per run of the function it returns. */
export const unscored = (conduit: Address) =>
  warnOnce("the immutable conduit can't score its vote in force; its simulation checks the vote", { conduit });

/** The conduit's checks at `values`, with its score of the vote in force as read with the votes, if it could score. */
export function onchainOf(state: State, values: Map<Address, number> | undefined): Onchain | undefined {
  return values && state.score !== undefined ? { values, current: usd(state.score) } : undefined;
}

export function immutableCandidates(state: State, usdValues: number[]): Candidate[] {
  return state.pools.map((p, i) => ({
    pool: p.pool,
    rewardsUsd: usdValues[i]!,
    otherVotes: p.otherVotes + p.ownVotes - p.immutableVotes,
    ownVotes: p.immutableVotes,
  }));
}

export function votesOf(candidates: { pool: Address }[], vote: Vote, power: bigint): bigint[] {
  const total = vote.weights.reduce((a, b) => a + b, 0n);
  const weights = new Map(vote.pools.map((pool, i) => [lower(pool), vote.weights[i]!]));
  return candidates.map(({ pool }) => ((weights.get(lower(pool)) ?? 0n) * power) / total);
}

/**
 * A day before the flip the vote is proportional to rewards; otherwise it is the water-filling vote, if that gains more
 * than MIN_GAIN_USD. If it wouldn't beat the vote in force by MIN_GAIN plus MARGIN at the conduit's own values, the
 * best vote that does replaces it, as long as that one still gains more than MIN_GAIN_USD. Without `onchain`, only the
 * simulation checks the vote.
 */
export function decideImmutable(
  state: State,
  usdValues: number[],
  onchain: Onchain | undefined,
  proportionally = false,
): ImmutableDecision {
  const candidates = immutableCandidates(state, usdValues);
  const { power } = state.epoch.immutable;
  const keep = (note: string, summary: Record<string, unknown> = {}): ImmutableDecision => ({
    vote: null,
    note,
    votes: candidates.map((c) => c.ownVotes),
    summary,
  });
  if (power === 0n) return keep("the immutable conduit has no voting power this epoch");
  let x: number[] | null;
  if (proportionally) x = proportional(usdValues, MAX_IMMUTABLE_POOLS);
  else {
    // If our best vote doesn't gain enough at our prices, no vote that clears the check will.
    const best = select(candidates, power, MAX_IMMUTABLE_POOLS);
    if (best.fractions && !best.vote)
      return keep("keeping the immutable conduit's vote", summarize(candidates, best.fractions, power));
    x = best.fractions;
  }
  if (!x) return keep("no pool pays anything; keeping the immutable conduit's vote");
  let checked: { bar: number; score: number } | undefined;
  if (onchain) {
    const values = candidates.map((c) => onchain.values.get(lower(c.pool)) ?? 0);
    const bar = onchain.current + MIN_GAIN + MARGIN;
    if (score(candidates, values, asVoted(x), power) < bar) {
      // Unlike a proportional vote, the replacement must gain as much as a last-block vote would.
      x = waterFillAbove(candidates, power, values, bar, MAX_IMMUTABLE_POOLS, proportionally ? undefined : x);
      if (!x) return keep("no vote clears the immutable conduit's check; keeping its vote", { bar });
      if (gain(candidates, x, power) <= MIN_GAIN_USD) {
        return keep("no vote that clears the immutable conduit's check gains enough; keeping its vote", { bar });
      }
    }
    checked = { bar, score: score(candidates, values, asVoted(x), power) };
  }
  const summary = { ...summarize(candidates, x, power), ...checked };
  const vote = toVote(candidates, x);
  return { vote, note: "", votes: votesOf(candidates, vote, power), summary };
}

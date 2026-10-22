import { isAddressEqual, type Address } from "viem";
import { immutableAbi } from "./abi.ts";
import { call, lower, readEach, readMany, type Chain, type Client, type V2 } from "./chain.ts";
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

// The immutable conduit (hydrex-conduit version 2) lets anyone propose its vote. It only accepts a vote whose score,
// counted in the tokens it prices with Chainlink, beats the vote in force by MIN_GAIN. The job picks votes at its own
// prices and checks the conduit's score before sending.
const MAX_V2_POOLS = 20; // the conduit's MAX_POOLS
const MIN_GAIN = 1; // USD, the conduit's MIN_GAIN
const MARGIN = 0.1; // USD above MIN_GAIN, in case other votes move before ours lands
const MAX_PRICED_TOKENS = 4; // the conduit's limit
const VALUE_CHUNK = 25; // poolValue calls per eth_call, because each can use 200k gas
const VALUE_CONCURRENCY = 3; // kept low because these reads repeat every block, on the RPCs the votes use

/** `current` is the conduit's score of the vote in force, in USD. */
export type Onchain = { values: Map<Address, number>; current: number };

export type V2Decision = { vote: Vote | null; note: string; votes: bigint[]; summary: Record<string, unknown> };

const v2Call = (conduit: Address, functionName: string, args?: readonly unknown[]) =>
  call(conduit, immutableAbi, functionName, args);

const usd = (wad: bigint) => Number(wad) / 1e18;

export async function connectV2(chain: Chain, { conduit, proposer }: Omit<V2, "priced">): Promise<V2> {
  const [voter, ve] = await readMany<Address>(chain.client, [v2Call(conduit, "voter"), v2Call(conduit, "veToken")]);
  if (!isAddressEqual(voter!, chain.voter) || !isAddressEqual(ve!, chain.ve)) {
    throw new Error(`${conduit} uses Voter ${voter} and VotingEscrow ${ve}, not ${chain.voter} and ${chain.ve}`);
  }
  const calls = Array.from({ length: MAX_PRICED_TOKENS }, (_, i) => v2Call(conduit, "pricedTokens", [BigInt(i)]));
  const entries = await readEach<readonly [Address, ...unknown[]]>(chain.client, calls);
  const priced = entries.flatMap((entry) => (entry ? [entry[0]] : []));
  if (priced.length === 0) throw new Error(`${conduit} prices no token`);
  return { conduit, proposer, priced };
}

export function pricedPools(pools: PoolRewards[], priced: Address[]): Address[] {
  const tokens = new Set(priced.map(lower));
  return pools.filter((p) => p.rewards.some((r) => tokens.has(lower(r.token)))).map((p) => p.pool);
}

/** Fails while the conduit can't vote. */
export async function readValues(
  { v2 }: Chain,
  client: Client,
  pools: Address[],
  blockTag?: "pending",
): Promise<Map<Address, number>> {
  const calls = pools.map((pool) => v2Call(v2!.conduit, "poolValue", [pool]));
  const values = await readMany<bigint>(client, calls, {
    blockTag,
    chunk: VALUE_CHUNK,
    concurrency: VALUE_CONCURRENCY,
  });
  return new Map(pools.map((pool, i) => [lower(pool), usd(values[i]!)]));
}

export async function readScore({ v2 }: Chain, client: Client, blockTag?: "pending"): Promise<number> {
  const [current] = await readMany<bigint>(client, [v2Call(v2!.conduit, "currentScore")], { blockTag });
  return usd(current!);
}

export function v2Candidates(state: State, usdValues: number[]): Candidate[] {
  return state.pools.map((p, i) => ({
    pool: p.pool,
    rewardsUsd: usdValues[i]!,
    otherVotes: p.otherVotes + p.ownVotes - p.v2Votes,
    ownVotes: p.v2Votes,
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
export function decideV2(
  state: State,
  usdValues: number[],
  onchain: Onchain | undefined,
  proportionally = false,
): V2Decision {
  const candidates = v2Candidates(state, usdValues);
  const v2 = state.epoch.v2;
  const keep = (note: string, summary: Record<string, unknown> = {}): V2Decision => ({
    vote: null,
    note,
    votes: candidates.map((c) => c.ownVotes),
    summary,
  });
  if (!v2 || v2.power === 0n) return keep("v2 has no voting power this epoch");
  const { power } = v2;
  let x: number[] | null;
  if (proportionally) x = proportional(usdValues, MAX_V2_POOLS);
  else {
    // If our best vote doesn't gain enough at our prices, no vote that clears the check will.
    const best = select(candidates, power, MAX_V2_POOLS);
    if (best.fractions && !best.vote) return keep("keeping v2's vote", summarize(candidates, best.fractions, power));
    x = best.fractions;
  }
  if (!x) return keep("no pool pays anything; keeping v2's vote");
  let checked: { bar: number; score: number } | undefined;
  if (onchain) {
    const values = candidates.map((c) => onchain.values.get(lower(c.pool)) ?? 0);
    const bar = onchain.current + MIN_GAIN + MARGIN;
    if (score(candidates, values, asVoted(x), power) < bar) {
      // The replacement is no longer proportional, so it must gain as much as a last-block vote would.
      x = waterFillAbove(candidates, power, values, bar, MAX_V2_POOLS, proportionally ? undefined : x);
      if (!x) return keep("no vote clears v2's check; keeping its vote", { bar });
      if (gain(candidates, x, power) <= MIN_GAIN_USD) {
        return keep("no vote that clears v2's check gains enough; keeping its vote", { bar });
      }
    }
    checked = { bar, score: score(candidates, values, asVoted(x), power) };
  }
  const summary = { ...summarize(candidates, x, power), ...checked };
  const vote = toVote(candidates, x);
  return { vote, note: "", votes: votesOf(candidates, vote, power), summary };
}

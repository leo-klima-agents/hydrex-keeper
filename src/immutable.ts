import type { Address } from "viem";
import { immutableAbi } from "./abi.ts";
import { lower, readEach, readMany, type Call, type Chain } from "./chain.ts";
import type { PoolRewards, State } from "./read.ts";
import {
  expected,
  gain,
  MIN_GAIN_USD,
  proportional,
  score,
  toVote,
  waterFill,
  waterFillAbove,
  type Candidate,
  type Vote,
} from "./select.ts";

// The immutable conduit, version 2 of hydrex-conduit: anyone may propose its vote, and it takes one only if its own
// score, in Chainlink-priced tokens, beats the vote in force by MIN_GAIN. The job values votes at its own prices, and
// checks that score before sending.

export const MAX_V2_POOLS = 20; // the conduit's MAX_POOLS
const MIN_GAIN = 1; // USD: the conduit's MIN_GAIN
const MARGIN = 0.1; // USD aimed for above MIN_GAIN: rounding, and votes that move before ours lands
const MAX_PRICED_TOKENS = 4; // the conduit's
const VALUE_CHUNK = 25; // poolValue calls per eth_call: each can use 200k gas

/** The conduit's own values of pools, in USD, and its score of the vote in force. */
export type Onchain = { values: Map<Address, number>; current: number };

/** What the immutable conduit does: a vote, or none and why; and its votes on each pool once it is decided. */
export type V2Decision = { vote: Vote | null; note: string; votes: bigint[]; summary: Record<string, unknown> };

const v2Call = ({ v2 }: Chain, functionName: string, args: readonly unknown[] = []): Call => ({
  address: v2!.conduit,
  abi: immutableAbi,
  functionName,
  args,
});

const usd = (wad: bigint) => Number(wad) / 1e18;

/** The tokens the conduit prices with Chainlink. */
export async function readPricedTokens(chain: Chain): Promise<Address[]> {
  const calls = Array.from({ length: MAX_PRICED_TOKENS }, (_, i) => v2Call(chain, "pricedTokens", [BigInt(i)]));
  const entries = await readEach<readonly [Address, ...unknown[]]>(chain.client, calls);
  return entries.flatMap((entry) => (entry ? [entry[0]] : []));
}

/** The pools the conduit can value: those paid this epoch in a token it prices. Its fees in others need one too. */
export function pricedPools(pools: PoolRewards[], priced: Address[]): Address[] {
  const tokens = new Set(priced.map(lower));
  return pools.filter((p) => p.rewards.some((r) => tokens.has(lower(r.token)))).map((p) => p.pool);
}

/** The conduit's values of `pools` and its score of the vote in force. Fails while the conduit cannot vote. */
export async function readOnchain(chain: Chain, pools: Address[], blockTag?: "pending"): Promise<Onchain> {
  const calls = [v2Call(chain, "currentScore"), ...pools.map((pool) => v2Call(chain, "poolValue", [pool]))];
  const [current, ...values] = await readMany<bigint>(chain.client, calls, { blockTag, chunk: VALUE_CHUNK });
  return { current: usd(current!), values: new Map(pools.map((pool, i) => [lower(pool), usd(values[i]!)])) };
}

/** The immutable conduit's view of the pools: every vote but its own counts as another's. */
export function v2Candidates(state: State, usdValues: number[]): Candidate[] {
  return state.pools.map((p, i) => ({
    pool: p.pool,
    rewardsUsd: usdValues[i]!,
    otherVotes: p.otherVotes + p.ownVotes - p.v2Votes,
    ownVotes: p.v2Votes,
  }));
}

/** The votes `vote` puts on each candidate, as the Voter splits `power` by weight. */
export function votesOf(candidates: { pool: Address }[], vote: Vote, power: bigint): bigint[] {
  const total = vote.weights.reduce((a, b) => a + b, 0n);
  const weights = new Map(vote.pools.map((pool, i) => [lower(pool), vote.weights[i]!]));
  return candidates.map(({ pool }) => ((weights.get(lower(pool)) ?? 0n) * power) / total);
}

/**
 * The immutable conduit's vote at our prices, against everyone else's votes, the Klima conduit's included: in
 * proportion to rewards a day before the flip, else the water-filling one if it gains over MIN_GAIN_USD. When it does
 * not score MIN_GAIN plus MARGIN over the vote in force at the conduit's own values, the best vote that does. Without
 * `onchain`, the simulation is left to check.
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
  let x = proportionally ? proportional(usdValues, MAX_V2_POOLS) : waterFill(candidates, power, MAX_V2_POOLS);
  if (!x) return keep("no pool pays anything; keeping v2's vote");
  const values = onchain && candidates.map((c) => onchain.values.get(lower(c.pool)) ?? 0);
  const bar = onchain && onchain.current + MIN_GAIN + MARGIN;
  const currentVote = candidates.filter((c) => c.ownVotes > 0n).map((c) => ({ pool: c.pool, votes: c.ownVotes }));
  const summary = { power, bar, currentVote };
  if (values && bar !== undefined && score(candidates, values, x, power) < bar) {
    x = waterFillAbove(candidates, power, values, bar, MAX_V2_POOLS);
    if (!x) return keep("no vote clears v2's check; keeping its vote", summary);
  }
  const plan = x
    .map((f, i) => ({ pool: candidates[i]!.pool, share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const scored = {
    ...summary,
    plan,
    expectedUsd: expected(candidates, x, power),
    ...(values ? { score: score(candidates, values, x, power) } : {}),
  };
  if (!proportionally && gain(candidates, x, power) <= MIN_GAIN_USD) return keep("keeping v2's vote", scored);
  const vote = toVote(candidates, x);
  return { vote, note: "", votes: votesOf(candidates, vote, power), summary: scored };
}

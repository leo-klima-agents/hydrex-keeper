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

// The immutable conduit, version 2 of hydrex-conduit: anyone may propose its vote, and it takes one only if its own
// score, in Chainlink-priced tokens, beats the vote in force by MIN_GAIN. The job values votes at its own prices, and
// checks that score before sending.

const MAX_V2_POOLS = 20; // the conduit's MAX_POOLS
const MIN_GAIN = 1; // USD: the conduit's MIN_GAIN
const MARGIN = 0.1; // USD aimed for above MIN_GAIN, for votes that move before ours lands
const MAX_PRICED_TOKENS = 4; // the conduit's
const VALUE_CHUNK = 25; // poolValue calls per eth_call: each can use 200k gas
const VALUE_CONCURRENCY = 3; // such eth_calls at once: they are read again every block, from the RPCs votes need too

/** The conduit's own values of pools, in USD, and its score of the vote in force. */
export type Onchain = { values: Map<Address, number>; current: number };

/** What the immutable conduit does: a vote, or none and why; and its votes on each pool once it is decided. */
export type V2Decision = { vote: Vote | null; note: string; votes: bigint[]; summary: Record<string, unknown> };

const v2Call = (conduit: Address, functionName: string, args?: readonly unknown[]) =>
  call(conduit, immutableAbi, functionName, args);

const usd = (wad: bigint) => Number(wad) / 1e18;

/**
 * The immutable conduit at `conduit`, checked against the Klima conduit's Voter and VotingEscrow, with the tokens it
 * prices. Fails, and the job then votes without it, if `conduit` is not such a conduit.
 */
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

/** The pools the conduit can value: those paid this epoch in a token it prices. Its fees in others need one too. */
export function pricedPools(pools: PoolRewards[], priced: Address[]): Address[] {
  const tokens = new Set(priced.map(lower));
  return pools.filter((p) => p.rewards.some((r) => tokens.has(lower(r.token)))).map((p) => p.pool);
}

/**
 * The conduit's values of `pools`, in USD. They do not depend on votes, and barely move within a block. Fails while the
 * conduit cannot vote.
 */
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

/** The conduit's score of its vote in force, in USD, which moves with every vote. */
export async function readScore({ v2 }: Chain, client: Client, blockTag?: "pending"): Promise<number> {
  const [current] = await readMany<bigint>(client, [v2Call(v2!.conduit, "currentScore")], { blockTag });
  return usd(current!);
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
 * not score MIN_GAIN plus MARGIN over the vote in force at the conduit's own values, once rounded as it is sent, the
 * best vote that does, if that one gains over MIN_GAIN_USD on the vote in force. Without `onchain`, the simulation is
 * left to check.
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
    // A vote that clears the check gains no more at our prices than our best, so that one is the cheap test.
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
      // Unless proportionally, `x` is already our water-filling, which falls short. Whichever replaces it is no longer
      // in proportion, so it must gain as much as a vote of the last blocks would.
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

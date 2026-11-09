import type { Address } from "viem";
import { CONDUITS, lower, TRAITS, type ByConduit, type ConduitName } from "./chain.ts";
import { clearCheck, type Onchain } from "./onchain.ts";
import { othersOf, type State } from "./read.ts";
import { planOf, proportional, select, summarize, toVote, type Candidate, type Vote } from "./select.ts";

/** `votes` are the conduit's votes on each pool once its vote lands, or as they are if it keeps its vote. */
export type Decision = { vote: Vote | null; note: string; votes: bigint[]; summary: Record<string, unknown> };

/** Votes that replace another conduit's votes in force, keyed by lowercase pool. */
export type Planned = Partial<ByConduit<Map<Address, bigint>>>;

/** `name`'s candidates: each pool's rewards and everyone else's votes, with `planned` in place of those in force. */
export function candidatesFor(state: State, usd: number[], name: ConduitName, planned: Planned = {}): Candidate[] {
  return state.pools.map((p, i) => {
    let otherVotes = othersOf(p, name);
    for (const other of CONDUITS) {
      const votes = other === name ? undefined : planned[other];
      if (votes) otherVotes += (votes.get(lower(p.pool)) ?? 0n) - p.votes[other];
    }
    return { pool: p.pool, rewardsUsd: usd[i]!, otherVotes, ownVotes: p.votes[name] };
  });
}

export function votesOf(candidates: { pool: Address }[], vote: Vote, power: bigint): bigint[] {
  const total = vote.weights.reduce((a, b) => a + b, 0n);
  const weights = new Map(vote.pools.map((pool, i) => [lower(pool), vote.weights[i]!]));
  return candidates.map(({ pool }) => ((weights.get(lower(pool)) ?? 0n) * power) / total);
}

/**
 * A day before the flip, the vote of a conduit that doesn't check votes on chain: in proportion to each pool's rewards,
 * whatever the votes, so they aren't read.
 */
export function proportionalVote(
  name: ConduitName,
  pools: { pool: Address }[],
  usd: number[],
): Pick<Decision, "vote" | "note" | "summary"> {
  const x = proportional(usd, TRAITS[name].maxPools);
  if (!x) return { vote: null, note: "no pool pays anything; keeping the vote in force", summary: {} };
  return { vote: toVote(pools, x), note: "", summary: { plan: planOf(pools, x) } };
}

export type DecideOptions = {
  /** For a conduit that checks votes on chain: its check, if it could be read. Without it, the simulation checks. */
  onchain?: Onchain | undefined;
  planned?: Planned;
  /** A day before the flip, the vote is proportional to rewards. */
  proportionally?: boolean;
};

/**
 * `name`'s vote: proportional to rewards a day before the flip, otherwise the water-filling vote, if that gains more
 * than MIN_GAIN_USD. With `onchain`, the vote must also clear the conduit's check (see `clearCheck`).
 */
export function decide(
  name: ConduitName,
  state: State,
  usd: number[],
  { onchain, planned, proportionally = false }: DecideOptions = {},
): Decision {
  const candidates = candidatesFor(state, usd, name, planned);
  const { power } = state.epoch.votes[name];
  const { maxPools } = TRAITS[name];
  const keep = (note: string, fractions: number[] | null = null, more: Record<string, unknown> = {}): Decision => ({
    vote: null,
    note,
    votes: candidates.map((c) => c.ownVotes),
    summary: { ...summarize(candidates, fractions, power), ...more },
  });
  if (power === 0n) return keep("no voting power this epoch");
  let x: number[] | null;
  if (proportionally) x = proportional(usd, maxPools);
  else {
    // If our best vote doesn't gain enough at our prices, no vote that clears a check will.
    const best = select(candidates, power, maxPools);
    if (best.fractions && !best.vote) return keep("keeping the vote in force", best.fractions);
    x = best.fractions;
  }
  if (!x) return keep("no pool pays anything; keeping the vote in force");
  let checked: Record<string, unknown> = {};
  if (onchain) {
    const cleared = clearCheck(candidates, x, power, onchain, maxPools, proportionally);
    if ("note" in cleared) return keep(cleared.note, null, { bar: cleared.bar });
    ({ x, checked } = cleared);
  }
  const vote = toVote(candidates, x);
  return {
    vote,
    note: "",
    votes: votesOf(candidates, vote, power),
    summary: { ...summarize(candidates, x, power), ...checked },
  };
}

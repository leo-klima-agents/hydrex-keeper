import type { Address } from "viem";

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint; ownVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

const BPS = 10_000;
export const MIN_GAIN_USD = 1; // re-vote only when the expected reward improves by this much
const MIN_SHARE = 0.001; // pools that would get less are left out to save gas
const MAX_POOLS = 40; // more could take a vote past the gas a Base transaction may use

/** Expected USD of putting fractions `x` (of `power`) on the candidates: Σ B·x/(V + x). */
export function expected(candidates: Candidate[], x: number[], power: bigint): number {
  const v = Number(power);
  return candidates.reduce((sum, c, i) => {
    const votes = x[i]! * v;
    return votes > 0 ? sum + c.rewardsUsd * (votes / (Number(c.otherVotes) + votes)) : sum;
  }, 0);
}

/** The shares a vote keeps: those of at least MIN_SHARE, up to the `maxPools` largest. */
function kept(x: number[], maxPools: number): boolean[] {
  const byShare = x.map((_, i) => i).sort((a, b) => x[b]! - x[a]!);
  const largest = new Set(byShare.slice(0, maxPools));
  return x.map((xi, i) => xi >= MIN_SHARE && largest.has(i));
}

/** Shares in proportion to `rewards`; those not kept are dropped and the rest scaled up. Null when nothing pays. */
export function proportional(rewards: number[], maxPools = MAX_POOLS): number[] | null {
  const normalize = (xs: number[]) => {
    const total = xs.reduce((a, b) => a + b, 0);
    return total > 0 ? xs.map((x) => x / total) : null;
  };
  const shares = normalize(rewards.map((r) => Math.max(r, 0)));
  if (!shares) return null;
  const keep = kept(shares, maxPools);
  return normalize(shares.map((share, i) => (keep[i] ? share : 0)));
}

/**
 * Water-filling: the marginal reward B·V/(V + x)² of a pool falls as x grows, so the optimum gives every funded
 * pool the same marginal λ: x = max(0, √(B·V/λ) − V), with λ such that Σx = v. The shares not kept are dropped and
 * the rest re-solved. Returns fractions of `power`, or null when nothing pays.
 */
export function waterFill(candidates: Candidate[], power: bigint, maxPools = MAX_POOLS): number[] | null {
  let x = solve(candidates, power);
  while (x) {
    const keep = kept(x, maxPools);
    if (x.every((xi, i) => xi === 0 || keep[i])) break;
    const rest = candidates.map((c, i) => (keep[i] ? c : { ...c, rewardsUsd: 0 }));
    x = solve(rest, power);
  }
  return x;
}

function solve(candidates: Candidate[], power: bigint): number[] | null {
  const v = Number(power);
  const floor = v / BPS; // a pool nobody voted for is worth a minimum bid, not the whole pot for nothing
  const V = candidates.map((c) => Math.max(Number(c.otherVotes), floor));
  const B = candidates.map((c) => Math.max(c.rewardsUsd, 0));
  if (!B.some((b) => b > 0)) return null;
  const at = (lambda: number) => B.map((b, i) => Math.max(0, Math.sqrt((b * V[i]!) / lambda) - V[i]!));
  let lo = 0;
  let hi = Math.max(...B.map((b, i) => b / V[i]!));
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid).reduce((a, b) => a + b, 0) > v) lo = mid;
    else hi = mid;
  }
  const x = at(hi);
  const total = x.reduce((a, b) => a + b, 0);
  return x.map((xi) => xi / total);
}

/** `fractions` in basis points, as a vote's weights. */
const bps = (fractions: number[]) => fractions.map((f) => Math.round(f * BPS));

/** `fractions` of the votes on `pools`, in basis points; the pools that get none are left out. */
export function toVote(pools: { pool: Address }[], fractions: number[]): Vote {
  const weights = bps(fractions);
  const funded = pools.flatMap((_, i) => (weights[i]! > 0 ? [i] : []));
  return { pools: funded.map((i) => pools[i]!.pool), weights: funded.map((i) => BigInt(weights[i]!)) };
}

/** The shares a vote of `fractions` gives once rounded to basis points, as the Voter splits its power by weight. */
export function asVoted(fractions: number[]): number[] {
  const weights = bps(fractions);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (total > 0 ? w / total : 0));
}

/** What voting `fractions`, rounded as a vote is, would add to the expected reward of the vote in force. */
export function gain(candidates: Candidate[], fractions: number[], power: bigint): number {
  const current = candidates.map((c) => Number(c.ownVotes) / Number(power));
  return expected(candidates, asVoted(fractions), power) - expected(candidates, current, power);
}

/** For the logs: the shares of `fractions` in percent, their expected reward, and the vote in force. */
export function summarize(candidates: Candidate[], fractions: number[] | null, power: bigint) {
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: candidates[i]!.pool, share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, power) : 0;
  const currentVote = candidates.filter((c) => c.ownVotes > 0n).map((c) => ({ pool: c.pool, votes: c.ownVotes }));
  return { plan, expectedUsd, currentVote, power };
}

/** The water-filling allocation and its vote; the vote is null when nothing pays or the gain is under MIN_GAIN_USD. */
export function select(
  candidates: Candidate[],
  power: bigint,
  maxPools = MAX_POOLS,
): { fractions: number[] | null; vote: Vote | null } {
  const fractions = waterFill(candidates, power, maxPools);
  if (!fractions) return { fractions, vote: null };
  if (gain(candidates, fractions, power) <= MIN_GAIN_USD) return { fractions, vote: null };
  return { fractions, vote: toVote(candidates, fractions) };
}

/** The expected reward of `fractions` with the rewards valued at `values` instead, as a conduit scores a vote. */
export function score(candidates: Candidate[], values: number[], fractions: number[], power: bigint): number {
  return expected(
    candidates.map((c, i) => ({ ...c, rewardsUsd: values[i]! })),
    fractions,
    power,
  );
}

/**
 * The best allocation at our prices that scores at least `bar` at the conduit's own `values`, once rounded as a vote is.
 * Both have the form Σ B·x/(V + x) with the same V, so it is the water-filling of our rewards plus μ times the
 * conduit's values, for the smallest μ that clears the bar, found by bisection. Null when not even the conduit's own
 * best clears it. `ours`, our water-filling with `maxPools`, if already known.
 */
export function waterFillAbove(
  candidates: Candidate[],
  power: bigint,
  values: number[],
  bar: number,
  maxPools = MAX_POOLS,
  ours?: number[] | null,
): number[] | null {
  const blend = (mu: number) =>
    waterFill(
      candidates.map((c, i) => ({ ...c, rewardsUsd: Math.max(c.rewardsUsd, 0) + mu * Math.max(values[i]!, 0) })),
      power,
      maxPools,
    );
  const clears = (x: number[] | null): x is number[] =>
    x !== null && score(candidates, values, asVoted(x), power) >= bar;
  const first = ours === undefined ? blend(0) : ours;
  if (clears(first)) return first;
  const scale = Math.max(...values, 0);
  if (scale === 0) return null;
  // Here the conduit's values outweigh ours a million to one: its own best, give or take ties.
  let hi = (1e6 * Math.max(...candidates.map((c) => c.rewardsUsd), 1)) / scale;
  let best = blend(hi);
  if (!clears(best)) return null;
  let lo = 0;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    const x = blend(mid);
    if (clears(x)) [hi, best] = [mid, x];
    else lo = mid;
  }
  return best;
}

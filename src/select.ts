import type { Address } from "viem";

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint; ownVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

const BPS = 10_000;
export const MIN_GAIN_USD = 1; // a new vote must add this much expected reward
const MIN_SHARE = 0.001; // smaller shares are dropped to save gas
const MAX_POOLS = 40; // more pools could go over Base's gas limit per transaction

/** Expected USD reward of voting fractions `x` of `power`: the sum of B·x/(V + x) over the pools. */
export function expected(candidates: Candidate[], x: number[], power: bigint): number {
  const v = Number(power);
  return candidates.reduce((sum, c, i) => {
    const votes = x[i]! * v;
    return votes > 0 ? sum + c.rewardsUsd * (votes / (Number(c.otherVotes) + votes)) : sum;
  }, 0);
}

function kept(x: number[], maxPools: number): boolean[] {
  const byShare = x.map((_, i) => i).sort((a, b) => x[b]! - x[a]!);
  const largest = new Set(byShare.slice(0, maxPools));
  return x.map((xi, i) => xi >= MIN_SHARE && largest.has(i));
}

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
 * Water-filling. A pool's marginal reward B·V/(V + x)² falls as x grows, so the best split gives every funded pool the
 * same marginal reward λ. Then x = max(0, √(B·V/λ) − V), with λ set so that the x add up to the voting power. Shares
 * too small to keep are dropped, and the rest is solved again.
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
  const floor = v / BPS; // so that a pool nobody voted for doesn't look free
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

const bps = (fractions: number[]) => fractions.map((f) => Math.round(f * BPS));

export function toVote(pools: { pool: Address }[], fractions: number[]): Vote {
  const weights = bps(fractions);
  const funded = pools.flatMap((_, i) => (weights[i]! > 0 ? [i] : []));
  return { pools: funded.map((i) => pools[i]!.pool), weights: funded.map((i) => BigInt(weights[i]!)) };
}

export function asVoted(fractions: number[]): number[] {
  const weights = bps(fractions);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (total > 0 ? w / total : 0));
}

export function gain(candidates: Candidate[], fractions: number[], power: bigint): number {
  const current = candidates.map((c) => Number(c.ownVotes) / Number(power));
  return expected(candidates, asVoted(fractions), power) - expected(candidates, current, power);
}

export function summarize(candidates: Candidate[], fractions: number[] | null, power: bigint) {
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: candidates[i]!.pool, share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, power) : 0;
  const currentVote = candidates.filter((c) => c.ownVotes > 0n).map((c) => ({ pool: c.pool, votes: c.ownVotes }));
  return { plan, expectedUsd, currentVote, power };
}

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

export function score(candidates: Candidate[], values: number[], fractions: number[], power: bigint): number {
  return expected(
    candidates.map((c, i) => ({ ...c, rewardsUsd: values[i]! })),
    fractions,
    power,
  );
}

/**
 * The best split at our prices whose score at the conduit's `values` is at least `bar` once rounded. Both rewards have
 * the form B·x/(V + x) with the same V, so the answer is the water-filling of our rewards plus μ times the conduit's
 * values, for the smallest μ that clears the bar. μ is found by bisection. Returns null when even the conduit's own
 * best split falls short. `ours` is our plain water-filling, if already known.
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
  // At this μ the conduit's values outweigh ours a million to one, so the split is the conduit's own best, give or take
  // ties.
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

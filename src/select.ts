import type { Address } from "viem";

// The selection algorithm, and nothing else. Replace `select` to change the strategy.

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

export type Current = { pools: Address[]; votes: bigint[] };

const BPS = 10_000;
const MIN_GAIN = 0.01; // re-vote only when the expected reward improves by this fraction
const MIN_SHARE = 0.001; // pools that would get less are dropped: each costs gas for cents

/** Expected USD of putting fractions `x` (of `power`) on the candidates: Σ B·x/(V + x). */
export function expected(candidates: Candidate[], x: number[], power: bigint): number {
  const v = Number(power);
  return candidates.reduce((sum, c, i) => {
    const votes = x[i]! * v;
    return votes > 0 ? sum + c.rewardsUsd * (votes / (Number(c.otherVotes) + votes)) : sum;
  }, 0);
}

/**
 * Water-filling: the marginal reward B·V/(V + x)² of each pool decreases with x, so the optimum
 * equalises marginals at a level λ, x = max(0, √(B·V/λ) − V), with λ found so that Σx = v.
 * Pools whose share would be below MIN_SHARE are dropped and the rest re-solved.
 * Returns fractions of `power`, or null when nothing pays.
 */
export function allocate(candidates: Candidate[], power: bigint): number[] | null {
  let x = solve(candidates, power);
  for (;;) {
    if (!x) return null;
    const kept = candidates.map((c, i) => (x![i]! >= MIN_SHARE ? c : { ...c, rewardsUsd: 0 }));
    if (!x.some((xi, i) => xi > 0 && xi < MIN_SHARE)) return x;
    x = solve(kept, power);
  }
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
    const mid = lo === 0 ? hi / 2 : (lo + hi) / 2;
    if (at(mid).reduce((a, b) => a + b, 0) > v) lo = mid;
    else hi = mid;
  }
  const x = at(hi);
  const total = x.reduce((a, b) => a + b, 0);
  return x.map((xi) => xi / total);
}

/** The vote to cast, or null to keep the current one (nothing pays, or the gain is below MIN_GAIN). */
export function select(candidates: Candidate[], power: bigint, current: Current): Vote | null {
  const fractions = allocate(candidates, power);
  if (!fractions) return null;
  const weights = fractions.map((f) => Math.round(f * BPS));
  const pools: Address[] = [];
  const bps: bigint[] = [];
  candidates.forEach((c, i) => {
    if (weights[i]! > 0) {
      pools.push(c.pool);
      bps.push(BigInt(weights[i]!));
    }
  });
  const rounded = candidates.map((_, i) => weights[i]! / BPS);
  const now = candidates.map((c) => {
    const k = current.pools.findIndex((p) => p.toLowerCase() === c.pool.toLowerCase());
    return k < 0 ? 0 : Number(current.votes[k]!) / Number(power);
  });
  const gain = expected(candidates, rounded, power) - expected(candidates, now, power);
  return gain > MIN_GAIN * expected(candidates, rounded, power) ? { pools, weights: bps } : null;
}

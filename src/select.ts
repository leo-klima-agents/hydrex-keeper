import type { Address } from "viem";

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint; ownVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

/** How to split the votes: `optimal` maximises the expected reward, `proportional` mirrors the rewards. */
export type Mode = "optimal" | "proportional";

const BPS = 10_000;
const MIN_GAIN = 0.01; // re-vote only when the expected reward improves by this fraction
const MIN_MOVE = 0.01; // re-vote proportionally only when at least this fraction of the power changes pool
const MIN_SHARE = 0.001; // pools that would get less are left out to save gas

/** Expected USD of putting fractions `x` (of `power`) on the candidates: Σ B·x/(V + x). */
export function expected(candidates: Candidate[], x: number[], power: bigint): number {
  const v = Number(power);
  return candidates.reduce((sum, c, i) => {
    const votes = x[i]! * v;
    return votes > 0 ? sum + c.rewardsUsd * (votes / (Number(c.otherVotes) + votes)) : sum;
  }, 0);
}

/**
 * Water-filling: the marginal reward B·V/(V + x)² of a pool falls as x grows, so the optimum gives every funded
 * pool the same marginal λ: x = max(0, √(B·V/λ) − V), with λ such that Σx = v. Shares under MIN_SHARE are dropped
 * and the rest re-solved. Returns fractions of `power`, or null when nothing pays.
 */
export function allocate(candidates: Candidate[], power: bigint): number[] | null {
  let x = solve(candidates, power);
  while (x?.some((xi) => xi > 0 && xi < MIN_SHARE)) {
    const shares = x;
    const kept = candidates.map((c, i) => (shares[i]! >= MIN_SHARE ? c : { ...c, rewardsUsd: 0 }));
    x = solve(kept, power);
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

/**
 * Proportional: x = B/ΣB, ignoring the other voters. A baseline for when they have not settled, or can no longer be
 * reacted to, so there is nothing to optimise against. Shares under MIN_SHARE are dropped and the rest renormalised.
 * Returns fractions, or null when nothing pays.
 */
export function proportional(candidates: Candidate[]): number[] | null {
  let B = candidates.map((c) => Math.max(c.rewardsUsd, 0));
  for (;;) {
    const total = B.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const x = B.map((b) => b / total);
    const small = x.map((xi) => xi > 0 && xi < MIN_SHARE);
    if (!small.some(Boolean)) return x;
    B = B.map((b, i) => (small[i] ? 0 : b));
  }
}

/**
 * The allocation and the vote to cast. The vote is null when nothing pays, or when the change is not worth a
 * transaction: an optimal vote must gain MIN_GAIN of expected reward, a proportional one must move MIN_MOVE of the
 * power. The expected reward of a proportional vote may well be lower than the current one's; that is not its point.
 */
export function select(
  candidates: Candidate[],
  power: bigint,
  mode: Mode = "optimal",
): { fractions: number[] | null; vote: Vote | null } {
  const fractions = mode === "optimal" ? allocate(candidates, power) : proportional(candidates);
  if (!fractions) return { fractions, vote: null };
  const weights = fractions.map((f) => Math.round(f * BPS));
  const rounded = weights.map((w) => w / BPS);
  const current = candidates.map((c) => Number(c.ownVotes) / Number(power));
  if (mode === "optimal") {
    const next = expected(candidates, rounded, power);
    if (next - expected(candidates, current, power) <= MIN_GAIN * next) return { fractions, vote: null };
  } else {
    const moved = rounded.reduce((sum, r, i) => sum + Math.max(0, r - current[i]!), 0);
    if (moved <= MIN_MOVE) return { fractions, vote: null };
  }
  const funded = candidates.flatMap((_, i) => (weights[i]! > 0 ? [i] : []));
  const vote = { pools: funded.map((i) => candidates[i]!.pool), weights: funded.map((i) => BigInt(weights[i]!)) };
  return { fractions, vote };
}

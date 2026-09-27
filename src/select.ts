import type { Address } from "viem";

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint; ownVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

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
 * Water-filling: the marginal reward B·V/(V + x)² of a pool falls as x grows, so the optimum gives every funded pool
 * the same marginal λ: x = max(0, √(B·V/λ) − V), with λ such that Σx = v. Shares under MIN_SHARE are dropped and the
 * rest re-solved. Returns fractions of `power`, or null when nothing pays.
 */
export function allocate(candidates: Candidate[], power: bigint): number[] | null {
  let x = solve(candidates, power);
  while (x?.some((xi) => xi > 0 && xi < MIN_SHARE)) {
    const shares = x;
    x = solve(candidates.map((c, i) => (shares[i]! >= MIN_SHARE ? c : { ...c, rewardsUsd: 0 })), power);
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

/** The allocation, and the vote to cast or null to keep the current one (nothing pays, or the gain is under MIN_GAIN). */
export function select(candidates: Candidate[], power: bigint): { fractions: number[] | null; vote: Vote | null } {
  const fractions = allocate(candidates, power);
  if (!fractions) return { fractions, vote: null };
  const weights = fractions.map((f) => Math.round(f * BPS));
  const funded = candidates.flatMap((_, i) => (weights[i]! > 0 ? [i] : []));
  const next = expected(candidates, weights.map((w) => w / BPS), power);
  const current = expected(candidates, candidates.map((c) => Number(c.ownVotes) / Number(power)), power);
  const vote = next - current > MIN_GAIN * next ? { pools: funded.map((i) => candidates[i]!.pool), weights: funded.map((i) => BigInt(weights[i]!)) } : null;
  return { fractions, vote };
}

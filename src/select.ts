import type { Address } from "viem";

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint; ownVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

/** Fractions of `power` for the candidates, or null when nothing pays. */
export type Strategy = (candidates: Candidate[], power: bigint) => number[] | null;

const BPS = 10_000;
const MIN_GAIN = 0.01; // re-vote only when the expected reward improves by this fraction
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

/** The shares a vote keeps: those of at least MIN_SHARE, up to the MAX_POOLS largest. */
function kept(x: number[]): boolean[] {
  const byShare = x.map((_, i) => i).sort((a, b) => x[b]! - x[a]!);
  const largest = new Set(byShare.slice(0, MAX_POOLS));
  return x.map((xi, i) => xi >= MIN_SHARE && largest.has(i));
}

/** In proportion to the rewards; the shares not kept are dropped and the rest scaled up. */
export function proportional(candidates: Candidate[]): number[] | null {
  const normalize = (xs: number[]) => {
    const total = xs.reduce((a, b) => a + b, 0);
    return total > 0 ? xs.map((x) => x / total) : null;
  };
  const shares = normalize(candidates.map((c) => Math.max(c.rewardsUsd, 0)));
  if (!shares) return null;
  const keep = kept(shares);
  return normalize(shares.map((share, i) => (keep[i] ? share : 0)));
}

/**
 * Water-filling: the marginal reward B·V/(V + x)² of a pool falls as x grows, so the optimum gives every funded
 * pool the same marginal λ: x = max(0, √(B·V/λ) − V), with λ such that Σx = v. The shares not kept are dropped and
 * the rest re-solved.
 */
export function waterFill(candidates: Candidate[], power: bigint): number[] | null {
  let x = solve(candidates, power);
  while (x) {
    const keep = kept(x);
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

/** The allocation and the vote to cast; the vote is null when nothing pays or the gain is under MIN_GAIN. */
export function select(
  candidates: Candidate[],
  power: bigint,
  strategy: Strategy,
): { fractions: number[] | null; vote: Vote | null } {
  const fractions = strategy(candidates, power);
  if (!fractions) return { fractions, vote: null };
  const weights = fractions.map((f) => Math.round(f * BPS));
  const rounded = weights.map((w) => w / BPS);
  const current = candidates.map((c) => Number(c.ownVotes) / Number(power));
  const next = expected(candidates, rounded, power);
  if (next - expected(candidates, current, power) <= MIN_GAIN * next) return { fractions, vote: null };
  const funded = candidates.flatMap((_, i) => (weights[i]! > 0 ? [i] : []));
  const vote = { pools: funded.map((i) => candidates[i]!.pool), weights: funded.map((i) => BigInt(weights[i]!)) };
  return { fractions, vote };
}

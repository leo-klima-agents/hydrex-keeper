import type { Address } from "viem";

// The selection algorithm, and nothing else. Replace `select` to change the strategy.

export type Candidate = { pool: Address; rewardsUsd: number; otherVotes: bigint };

export type Vote = { pools: Address[]; weights: bigint[] };

/**
 * Expected reward of putting all of `power` on one pool is
 * rewardsUsd * power / (otherVotes + power). Picks the largest; ties keep the
 * earlier candidate. Null when no pool pays anything.
 */
export function select(candidates: Candidate[], power: bigint): Vote | null {
  let best: Candidate | undefined;
  let bestScore = 0;
  for (const c of candidates) {
    const score = c.rewardsUsd * (Number(power) / Number(c.otherVotes + power));
    if (score > bestScore) [best, bestScore] = [c, score];
  }
  return best ? { pools: [best.pool], weights: [100n] } : null;
}

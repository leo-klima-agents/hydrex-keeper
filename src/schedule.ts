import { WEEK } from "./chain.ts";

export const DAY = 86_400n;
export const HORIZON = 3_600n;

/** The most recent flip at `at` (s). The Voter's next `flip` can already be past, until the minter starts the epoch. */
export const lastFlip = (flip: bigint, at: bigint) => (at < flip ? flip - WEEK : flip);

/**
 * What an execution started at `at` does: claim in the hour after a flip, vote in the last blocks if the flip is within
 * the hour ahead, or vote a day before the flip if that is within the hour either side.
 */
export function due(flip: bigint, at: bigint): "claims" | "day before" | "last blocks" | undefined {
  const flipped = lastFlip(flip, at);
  if (at >= flipped && at - flipped < HORIZON) return "claims";
  if (at < flip && flip - at <= HORIZON) return "last blocks";
  const dayBefore = flip - DAY;
  return at > dayBefore - HORIZON && at < dayBefore + HORIZON ? "day before" : undefined;
}

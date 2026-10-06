export const DAY = 86_400n;
export const HORIZON = 3_600n;

/**
 * What an execution started at `at` does: the vote a day before the flip if that is within the hour either side, or the
 * last blocks if the flip is within the hour ahead.
 */
export function due(flip: bigint, at: bigint): "day before" | "last blocks" | undefined {
  if (at < flip && flip - at <= HORIZON) return "last blocks";
  const dayBefore = flip - DAY;
  return at > dayBefore - HORIZON && at < dayBefore + HORIZON ? "day before" : undefined;
}

import { WEEK } from "./chain.ts";

export const DAY = 86_400n;
export const HORIZON = 3_600n;

/** The most recent flip at `at` (s). The Voter's next `flip` can already be past, until the minter starts the epoch. */
export const lastFlip = (flip: bigint, at: bigint) => (at < flip ? flip - WEEK : flip);

export type Due = "claims" | "day before" | "last blocks";

/**
 * What an execution started at `at` does: claim in the hour after a flip, vote in the last blocks if the flip is within
 * the hour ahead, or vote a day before the flip if that is within the hour either side.
 */
export function due(flip: bigint, at: bigint): Due | undefined {
  const flipped = lastFlip(flip, at);
  if (at >= flipped && at - flipped < HORIZON) return "claims";
  if (at < flip && flip - at <= HORIZON) return "last blocks";
  const dayBefore = flip - DAY;
  return at > dayBefore - HORIZON && at < dayBefore + HORIZON ? "day before" : undefined;
}

/** How an execution started: with `--now`, with `--claim`, or as the schedule starts it; a dry run; a retry. */
export type Start = { now: boolean; claim: boolean; dryRun: boolean; retry: boolean };

const SENDS = { claims: "claims", "day before": "vote of a day before the flip", "last blocks": "last-block votes" };

/**
 * What an execution started at `at` does: what is due, or what it was started by hand for, `--now` the vote of a day
 * before the flip and `--claim` the claims. A retry of the schedule's vote of a day before leaves out a conduit whose
 * vote is in (`recheck`). With nothing due, `exit` is the exit code: a retry succeeds, since the attempt that was due
 * already failed, and alerted, for what is wrong, and failing again would only start another retry that ends here
 * too; a first attempt fails, so that a schedule that misses its window alerts. Throws if what is sent by hand could
 * take the nonce of what the schedule sends at the same time; a dry run sends nothing.
 */
export function task(
  flip: bigint,
  at: bigint,
  { now, claim, dryRun, retry }: Start,
): { what: Due; recheck: boolean } | { what: undefined; exit: 0 | 1 } {
  const scheduled = due(flip, at);
  const byHand = claim ? "--claim" : now ? "--now" : undefined;
  if (byHand && scheduled && !dryRun) {
    throw new Error(`${byHand} would race the scheduled ${SENDS[scheduled]}: run it later`);
  }
  const what = claim ? "claims" : now ? "day before" : scheduled;
  return what ? { what, recheck: retry && !now } : { what, exit: retry ? 0 : 1 };
}

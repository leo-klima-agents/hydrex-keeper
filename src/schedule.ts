import { WEEK } from "./chain.ts";

export const DAY = 86_400n;
export const HORIZON = 3_600n;

/** The Voter's `flip` can be in the past until the minter starts the new epoch. */
export const lastFlip = (flip: bigint, at: bigint) => (at < flip ? flip - WEEK : flip);

export type Due = "claims" | "day before" | "last blocks";

export function due(flip: bigint, at: bigint): Due | undefined {
  const flipped = lastFlip(flip, at);
  if (at >= flipped && at - flipped < HORIZON) return "claims";
  if (at < flip && flip - at <= HORIZON) return "last blocks";
  const dayBefore = flip - DAY;
  return at > dayBefore - HORIZON && at < dayBefore + HORIZON ? "day before" : undefined;
}

export type Start = { now: boolean; claim: boolean; dryRun: boolean; retry: boolean };

const SENDS = { claims: "claims", "day before": "vote of a day before the flip", "last blocks": "last-block votes" };

/**
 * With nothing due, a retry exits 0 and a first attempt exits 1. The attempt that was due has already failed and
 * alerted, and failing again would only start another retry. A first attempt that fails alerts when the schedule fires
 * at the wrong time. Running by hand is refused when it could take the nonce of a scheduled run. Claims send for up to
 * an hour, so `--claim` also checks the hour ahead.
 */
export function task(
  flip: bigint,
  at: bigint,
  { now, claim, dryRun, retry }: Start,
): { what: Due; recheck: boolean } | { what: undefined; exit: 0 | 1 } {
  const scheduled = due(flip, at) ?? (claim ? due(flip, at + HORIZON) : undefined);
  const byHand = claim ? "--claim" : now ? "--now" : undefined;
  if (byHand && scheduled && !dryRun) {
    throw new Error(`${byHand} would race the scheduled ${SENDS[scheduled]}: run it later`);
  }
  const what = claim ? "claims" : now ? "day before" : scheduled;
  return what ? { what, recheck: retry && !now } : { what, exit: retry ? 0 : 1 };
}

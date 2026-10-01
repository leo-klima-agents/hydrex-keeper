import type { Mode } from "./select.ts";

export const HORIZON = 3600n; // an execution runs the passes due within this many seconds; HORIZON in sh/lib.sh
export const PROPORTIONAL_BEFORE = 3600n; // a pass earlier than this before the flip votes proportionally

/** Times (unix seconds) of the passes due within the horizon, earliest first. */
export function passTimes(flip: bigint, offsets: bigint[], at: bigint, horizon = HORIZON): bigint[] {
  return [...new Set(offsets.map((o) => flip - o))]
    .filter((t) => t > at && t <= at + horizon)
    .sort((a, b) => (a < b ? -1 : 1));
}

/** Whether a pass fell due within the horizon before `at`. */
export function missed(flip: bigint, offsets: bigint[], at: bigint): boolean {
  return offsets.some((o) => flip - o <= at && flip - o > at - HORIZON);
}

/** When the pass on every block starts: when due within the horizon, or right away if already due; not after the flip. */
export function everyBlockStart(
  flip: bigint,
  everyBlockFrom: bigint,
  at: bigint,
  horizon = HORIZON,
): bigint | undefined {
  const from = flip - everyBlockFrom;
  if (at >= flip || from > at + horizon) return undefined;
  return from > at ? from : at;
}

export type Schedule = { times: bigint[]; everyBlock?: bigint; note?: string };

/** The passes this execution runs: the ones due ahead, or a missed one right now, or none. */
export function schedule(
  flip: bigint,
  offsets: bigint[],
  everyBlockFrom: bigint,
  at: bigint,
  immediately: boolean,
): Schedule {
  if (immediately) return { times: [at] };
  const times = passTimes(flip, offsets, at);
  const everyBlock = everyBlockStart(flip, everyBlockFrom, at);
  const loop = everyBlock === undefined ? {} : { everyBlock };
  // A pass missed within the horizon runs now, unless the pass on every block already runs in its place.
  const windowOpen = everyBlock !== undefined && everyBlock <= at;
  if (times.length === 0 && !windowOpen && flip > at && missed(flip, offsets, at)) {
    return { times: [at], note: "running the missed pass now", ...loop };
  }
  if (times.length || everyBlock !== undefined) return { times, ...loop };
  return { times: [], note: `no pass due within ${HORIZON} s: flip at ${flip}, offsets ${offsets.join(",")}` };
}

/** Proportional far from the flip, when the other voters have not settled; for the best expected reward near it. */
export function modeAt(timestamp: bigint, flip: bigint): Mode {
  return timestamp < flip - PROPORTIONAL_BEFORE ? "proportional" : "optimal";
}

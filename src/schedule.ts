export const HORIZON = 3600n; // an execution runs the passes due within this many seconds; HORIZON in sh/lib.sh

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

type Schedule = { times: bigint[]; final: boolean; note?: string };

/**
 * The passes this execution runs: the ones due ahead, or a missed one right now, or none; and whether it votes the
 * last blocks, which it does when the flip is within the horizon.
 */
export function schedule(flip: bigint, offsets: bigint[], at: bigint, immediately: boolean): Schedule {
  const final = !immediately && flip > at && flip - at <= HORIZON;
  if (immediately) return { times: [at], final };
  const times = passTimes(flip, offsets, at);
  if (times.length) return { times, final };
  if (flip > at && missed(flip, offsets, at)) return { times: [at], final, note: "running the missed pass now" };
  if (final) return { times, final };
  return { times, final, note: `no pass due within ${HORIZON} s: flip at ${flip}, offsets ${offsets.join(",")}` };
}

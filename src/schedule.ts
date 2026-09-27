/** An execution runs the passes due within this many seconds; HORIZON in sh/lib.sh. */
export const HORIZON = 3600n;

/** Times (unix seconds) of the passes due within the horizon, earliest first. */
export function passTimes(flip: bigint, offsets: bigint[], at: bigint, horizon = HORIZON): bigint[] {
  return [...new Set(offsets.map((o) => flip - o))]
    .filter((t) => t > at && t <= at + horizon)
    .sort((a, b) => (a < b ? -1 : 1));
}

/** Whether a pass was due within the horizon before `at`: a late start, as opposed to a restart after the flip. */
export function missed(flip: bigint, offsets: bigint[], at: bigint, horizon = HORIZON): boolean {
  return offsets.some((o) => flip - o <= at && flip - o > at - horizon);
}

/** The passes this execution runs: the ones due ahead, or a missed one right now, or none. */
export function schedule(
  flip: bigint,
  offsets: bigint[],
  at: bigint,
  immediately: boolean,
): { times: bigint[]; note?: string } {
  if (immediately) return { times: [at] };
  const times = passTimes(flip, offsets, at);
  if (times.length) return { times };
  if (flip > at && missed(flip, offsets, at)) return { times: [at], note: "running the missed pass now" };
  return {
    times: [],
    note: `no pass due within ${HORIZON} s: the epoch flips at ${flip}, offsets ${offsets.join(",")}`,
  };
}

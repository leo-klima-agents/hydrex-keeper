export type Pending = { timestamp: number };

export type Seen = Pending & { seen: number; rtt: number };

export type Timing = { spacing: number; phase: number | undefined; skew: number; rtt: number };

export type Observed = { seeds: number[]; seen: Seen[]; rtts: number[] };

export const LEAD_MS = 500; // two flashblocks and propagation
const WINDOW = 5;
const DEFAULT_SPACING = 2;
const DEFAULT_RTT = 200;

export function median(xs: number[]): number | undefined {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Block spacing and phase from the timestamps seen, and when a block seals relative to its timestamp: a block appears
 * when the one before it seals. The first block seen was not seen appearing.
 */
export function timing({ seeds, seen, rtts }: Observed): Timing {
  const stamps = [...seeds, ...seen.map((s) => s.timestamp)].slice(-WINDOW - 1);
  const diffs = stamps.slice(1).map((t, i) => t - stamps[i]!);
  const spacing = median(diffs.filter((d) => d > 0)) ?? DEFAULT_SPACING;
  const skews = seen.slice(1, WINDOW + 1).map((s) => s.seen - s.rtt - (s.timestamp - spacing) * 1000);
  return {
    spacing,
    phase: stamps.length ? stamps.at(-1)! % spacing : undefined,
    skew: median(skews) ?? 0,
    rtt: median(rtts.slice(-4 * WINDOW)) ?? DEFAULT_RTT,
  };
}

/** Timestamps of the two last blocks before `flip`; an unknown phase assumes the last one seals as early as possible. */
export function slots(flip: number, { spacing, phase }: Timing): [number, number] {
  const last = phase === undefined ? flip - spacing : flip - 1 - ((flip - 1 - phase) % spacing);
  return [last - spacing, last];
}

export const sealAt = (timestamp: number, { skew }: Timing) => timestamp * 1000 + skew;

export const decideAt = (timestamp: number, t: Timing, pipelineMs: number) =>
  sealAt(timestamp, t) - LEAD_MS - pipelineMs - t.rtt;

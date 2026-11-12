import { BLOCK_MS, msOf, type Client } from "./chain.ts";
import { warnOnce } from "./log.ts";

const HISTORY = 30;
const FAST_POLL_MS = 100; // a slower poll could have seen its block anywhere in it, too loosely to time the seal
const SLACK = 2; // blocks a vote can land late and still be in the second it is for
const SECONDS = 2; // the last seconds before the flip, each with a vote
const POLL_MS = 50;
const POLL_TIMEOUT_MS = 500;

/** A block's number and its time in ms. */
type Header = { number: bigint; time: number };

/**
 * In ms. `seal` is how long after its time a block is first seen, at most 0, and `lead` how long before its block's
 * time a vote is sent: when that block's build starts.
 */
type Timing = { gap: number; seal: number; lead: number };

type Seen = { time: number; at: number; took: number };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// The global setTimeout, because node:test's mock timers can replace it but not the one in node:timers/promises.
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Learns block timing from polls of the latest block. Base makes a block every 200 ms, five in each second of
 * `block.timestamp`. The Voter takes one vote per conduit per second, so a vote goes in each of the last SECONDS
 * seconds before the flip, in the block SLACK blocks before that second's last, so that a vote that lands up to SLACK
 * blocks late still counts in that second. Base puts a transaction in the block being built when it reaches the
 * sequencer, so a vote is sent as its block's build starts, when the block before it is sealed: it then has the whole
 * build to arrive, and can't land in an earlier block.
 */
export class Blocks {
  #seen = new Map<bigint, Seen>();
  #last: bigint | undefined;
  #timing = timingOf(this.#seen);

  /**
   * Only the first sighting of a block counts, and none of a block older than one already seen. `took` is how long the
   * poll that saw it took.
   */
  observe({ number, time }: Header, at: number, took = 0): void {
    if (this.#last !== undefined && number <= this.#last) return;
    this.#seen.set(number, { time, at, took });
    this.#last = number;
    for (const n of this.#seen.keys()) if (n <= number - BigInt(HISTORY)) this.#seen.delete(n);
    this.#timing = timingOf(this.#seen);
  }

  get timing(): Timing {
    return this.#timing;
  }

  /** The time of the block being built at `now`: the first one not sealed yet. */
  building(now: number, { gap, seal } = this.timing): number | undefined {
    if (this.#last === undefined) return undefined;
    let time = this.#seen.get(this.#last)!.time;
    while (time + seal <= now) time += gap;
    return time;
  }

  /**
   * The first block after `after` that a vote goes in, while a vote sent at `now` would still keep a block of slack. It
   * lands in the block being built then, which is the vote's own block or one up to SLACK - 1 blocks after it.
   */
  next(flip: number, after: number, now: number): number | undefined {
    const timing = this.timing;
    const building = this.building(now, timing);
    if (building === undefined) return undefined;
    const lateness = (SLACK - 1) * timing.gap;
    return targets(flip, building, timing.gap).find((time) => time > after && time + lateness >= building);
  }

  /** The block the next vote goes in: the first whose deadline is still ahead at `now`. */
  upcoming(flip: number, now: number): number | undefined {
    return this.next(flip, now + this.timing.lead, now);
  }
}

function timingOf(seen: Map<bigint, Seen>): Timing {
  const gaps = [...seen].flatMap(([n, { time }]) => {
    const before = seen.get(n - 1n);
    return before && time > before.time ? [time - before.time] : [];
  });
  const gap = median(gaps) ?? BLOCK_MS;
  // The earliest sighting by a fast poll. A block is sealed before it is seen, so a vote goes out at or after its
  // block's build starts. Blocks seen late, from a lagging RPC, after a pause in the polls, or from a sequencer behind
  // its schedule, can't move the seal past a block's time.
  const fast = [...seen.values()].filter(({ took }) => took <= FAST_POLL_MS);
  const seal = Math.min(0, ...fast.map(({ time, at }) => at - time));
  return { gap, seal, lead: gap - seal };
}

/** In each of the last SECONDS seconds before `flip`, the block SLACK blocks before its last, on `anchor`'s grid. */
function targets(flip: number, anchor: number, gap: number): number[] {
  return Array.from({ length: SECONDS }, (_, i) => {
    const end = flip - (SECONDS - 1 - i) * 1000;
    const last = anchor + Math.floor((end - 1 - anchor) / gap) * gap;
    return last - SLACK * gap;
  });
}

export async function watch(client: Client, blocks: Blocks, stop: () => boolean): Promise<void> {
  const unstamped = warnOnce("a block without timestampMs is left out of the timing: is the RPC behind Base?");
  while (!stop()) {
    const started = Date.now();
    try {
      const block = await Promise.race([
        client.request({ method: "eth_getBlockByNumber", params: ["latest", false] }),
        sleep(POLL_TIMEOUT_MS).then(() => null),
      ]);
      if (block?.number) {
        const number = BigInt(block.number);
        const time = msOf(block);
        const took = Date.now() - started;
        if (time === undefined) unstamped(new Error(`block ${number} has no timestampMs`));
        else blocks.observe({ number, time }, started + took / 2, took);
      }
    } catch {}
    await sleep(Math.max(0, started + POLL_MS - Date.now()));
  }
}

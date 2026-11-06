import { msOf, type Client } from "./chain.ts";
import { warnOnce } from "./log.ts";

const HISTORY = 30;
const DEFAULT_GAP_MS = 200; // Base's block time since its Denim upgrade
const SEND_MARGIN_MS = 200; // covers poll lag and the time a vote takes to reach the sequencer
const SLACK = 1; // blocks a vote can land late and still be in the second it is for
const SECONDS = 2; // the last seconds before the flip, each with a vote
const POLL_MS = 50;
const POLL_TIMEOUT_MS = 500;

/** A block's number and its time in ms. */
type Header = { number: bigint; time: number };

/**
 * In ms. `seal` is how long after its time a block is first seen, at most 0, and `lead` how long before its block's time
 * a vote is sent.
 */
type Timing = { gap: number; seal: number; lead: number };

type Seen = { time: number; at: number };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// The global setTimeout, because node:test's mock timers can replace it but not the one in node:timers/promises.
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Learns block timing from polls of the latest block. Since Base's Denim upgrade, a block comes every 200 ms, five in
 * each second of `block.timestamp`. The Voter takes one vote per conduit per second, so a vote goes in each of the last
 * SECONDS seconds before the flip, in the block SLACK blocks before that second's last, so that a vote that lands a
 * block late still counts in that second. A vote is sent `lead` ms before its block's time, so that it reaches the
 * sequencer before that block's build starts, when the block before it is sealed.
 */
export class Blocks {
  #seen = new Map<bigint, Seen>();
  #last: bigint | undefined;

  /** Only the first sighting of a block counts, and none of a block older than one already seen. */
  observe({ number, time }: Header, at: number): void {
    if (this.#last !== undefined && number <= this.#last) return;
    this.#seen.set(number, { time, at });
    this.#last = number;
    for (const n of this.#seen.keys()) if (n <= number - BigInt(HISTORY)) this.#seen.delete(n);
  }

  get timing(): Timing {
    const seen = [...this.#seen];
    const gaps = seen.flatMap(([n, { time }]) => {
      const before = this.#seen.get(n - 1n);
      return before && time > before.time ? [time - before.time] : [];
    });
    const gap = median(gaps) ?? DEFAULT_GAP_MS;
    // The earliest sighting. Blocks seen late, from a lagging RPC, after a pause in the polls, or from a sequencer
    // behind its schedule, can only make votes go early, never late.
    const seal = Math.min(0, ...seen.map(([, { time, at }]) => at - time));
    return { gap, seal, lead: gap - seal + SEND_MARGIN_MS };
  }

  /** The time of the block being built at `now`: the first one not sealed yet. */
  building(now: number, { gap, seal } = this.timing): number | undefined {
    if (this.#last === undefined) return undefined;
    let time = this.#seen.get(this.#last)!.time;
    while (time + seal <= now) time += gap;
    return time;
  }

  /** The first block after `after` that a vote goes in and that isn't sealed at `now`. */
  next(flip: number, after: number, now: number): number | undefined {
    const timing = this.timing;
    const building = this.building(now, timing);
    if (building === undefined) return undefined;
    return targets(flip, building, timing.gap).find((time) => time > after && time >= building);
  }

  /** The block the next vote goes in: the first whose deadline is still ahead at `now`. */
  upcoming(flip: number, now: number): number | undefined {
    return this.next(flip, now + this.timing.lead, now);
  }
}

/** In each of the last SECONDS seconds before `flip`, the block SLACK blocks before its last, on the grid of `anchor`. */
function targets(flip: number, anchor: number, gap: number): number[] {
  const times: number[] = [];
  for (let end = flip - (SECONDS - 1) * 1000; end <= flip; end += 1000) {
    const last = anchor + Math.floor((end - 1 - anchor) / gap) * gap;
    const start = end - 1000;
    if (last < start) continue; // a second without a block
    times.push(Math.max(last - SLACK * gap, last - Math.floor((last - start) / gap) * gap));
  }
  return times;
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
        if (time === undefined) unstamped(new Error(`block ${number} has no timestampMs`));
        else blocks.observe({ number, time }, (started + Date.now()) / 2);
      }
    } catch {}
    await sleep(Math.max(0, started + POLL_MS - Date.now()));
  }
}

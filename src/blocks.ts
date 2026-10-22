import type { Client } from "./chain.ts";

const HISTORY = 30;
const DEFAULT_GAP_MS = 2_000;
const SEND_MARGIN_MS = 200; // covers poll lag and the time a vote takes to reach the builder
const POLL_MS = 50;
const POLL_TIMEOUT_MS = 500;

type Header = { number: bigint; timestamp: bigint; txs: number };

/** In ms. `seal` is how long after its timestamp a block is sealed, and `lead` how long before it a vote is sent. */
type Timing = { gap: number; maxGap: number; seal: number; lead: number };

type Seen = { time: number; txs: number; changes: number[] };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// The global setTimeout, because node:test's mock timers can replace it but not the one in node:timers/promises.
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Learns block timing from polls of the pending block. Base builds each block in sub-blocks, which appear one after
 * another until shortly before the block is sealed. A vote is sent `lead` ms before the block's timestamp so that it
 * reaches the builder before the last sub-block starts. When no sub-blocks are seen, it is sent half a block early.
 */
export class Blocks {
  #seen = new Map<bigint, Seen>();
  #last: bigint | undefined;

  observe({ number, timestamp, txs }: Header, at: number): void {
    if (this.#last !== undefined && number < this.#last) return;
    const seen = this.#seen.get(number);
    if (seen) {
      if (txs > seen.txs) {
        seen.txs = txs;
        seen.changes.push(at);
      }
      return;
    }
    this.#seen.set(number, { time: Number(timestamp) * 1000, txs, changes: [at] });
    this.#last = number;
    for (const n of this.#seen.keys()) if (n <= number - BigInt(HISTORY)) this.#seen.delete(n);
  }

  get timing(): Timing {
    const pairs = [...this.#seen].flatMap(([n, block]) => {
      const next = this.#seen.get(n + 1n);
      return next ? [{ block, next }] : [];
    });
    const gaps = pairs.map(({ block, next }) => next.time - block.time).filter((g) => g > 0);
    const gap = median(gaps) ?? DEFAULT_GAP_MS;
    const seal = median(pairs.map(({ block, next }) => next.changes[0]! - block.time)) ?? 0;
    const built = pairs.map(({ block }) => block).filter((b) => b.changes.length > 2);
    const lastStarts = median(built.map((b) => b.changes.at(-2)! - b.time));
    const lead = lastStarts === undefined ? gap / 2 : SEND_MARGIN_MS - lastStarts;
    return { gap, maxGap: Math.max(gap, ...gaps), seal, lead };
  }

  building(now: number, { gap, seal } = this.timing): number | undefined {
    if (this.#last === undefined) return undefined;
    let time = this.#seen.get(this.#last)!.time;
    while (time + seal <= now) time += gap;
    return time;
  }

  /** The first block after `after` that could be one of the last two before `flip`. */
  next(flip: number, after: number, now: number): number | undefined {
    const timing = this.timing;
    let time = this.building(now, timing);
    if (time === undefined) return undefined;
    while (time <= after || time + 2 * timing.maxGap < flip) time += timing.gap;
    return time < flip ? time : undefined;
  }
}

export async function watch(client: Client, blocks: Blocks, stop: () => boolean): Promise<void> {
  while (!stop()) {
    const started = Date.now();
    try {
      const block = await Promise.race([
        client.request({ method: "eth_getBlockByNumber", params: ["pending", false] }),
        sleep(POLL_TIMEOUT_MS).then(() => null),
      ]);
      if (block?.number) {
        const header = {
          number: BigInt(block.number),
          timestamp: BigInt(block.timestamp),
          txs: block.transactions.length,
        };
        blocks.observe(header, (started + Date.now()) / 2);
      }
    } catch {}
    await sleep(Math.max(0, started + POLL_MS - Date.now()));
  }
}

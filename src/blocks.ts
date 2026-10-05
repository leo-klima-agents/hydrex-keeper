import { setTimeout as sleep } from "node:timers/promises";
import type { Client } from "./chain.ts";

const HISTORY = 30; // blocks the timing is learned from
const DEFAULT_GAP_MS = 2_000;
const SEND_MARGIN_MS = 200; // polls see a sub-block up to POLL_MS late, and a vote takes time to reach the builder
const POLL_MS = 50;
const POLL_TIMEOUT_MS = 500;

export type Header = { number: bigint; timestamp: bigint; txs: number };

/** In ms: blocks are `gap` apart, at most `maxGap`; each is sealed `seal` after its timestamp. */
export type Timing = { gap: number; maxGap: number; seal: number; lead: number };

type Seen = { time: number; txs: number; changes: number[] };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/**
 * Block timing, learned from polls of the block being built; times are in ms. A block is built in sub-blocks that
 * appear one after another until shortly before it is sealed, each started when the one before appears. A vote is sent
 * `lead` before the block's timestamp, so that it reaches the builder before the last sub-block starts; without
 * sub-blocks, half a gap before.
 */
export class Blocks {
  #seen = new Map<bigint, Seen>();
  #last: bigint | undefined;

  /** Records a poll that saw block `number` holding `txs` transactions at `at`. */
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

  /** The timestamp of the block being built at `now`, extrapolated from the last one seen; undefined before any. */
  building(now: number, { gap, seal } = this.timing): number | undefined {
    if (this.#last === undefined) return undefined;
    let time = this.#seen.get(this.#last)!.time;
    while (time + seal <= now) time += gap;
    return time;
  }

  /** The first block after `after` that may be one of the last two before `flip`; undefined if none is left. */
  next(flip: number, after: number, now: number): number | undefined {
    const timing = this.timing;
    let time = this.building(now, timing);
    if (time === undefined) return undefined;
    while (time <= after || time + 2 * timing.maxGap < flip) time += timing.gap;
    return time < flip ? time : undefined;
  }
}

/** Polls the block being built into `blocks` until `stop()`; a poll that fails, hangs or is malformed is skipped. */
export async function watch(client: Client, blocks: Blocks, stop: () => boolean): Promise<void> {
  while (!stop()) {
    const started = Date.now();
    try {
      const block = await Promise.race([
        client.request({ method: "eth_getBlockByNumber", params: ["pending", false] }),
        sleep(POLL_TIMEOUT_MS, null),
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

import { setTimeout as sleep } from "node:timers/promises";
import type { Client } from "./chain.ts";
import { errorMessage, log } from "./log.ts";

export const HORIZON = 3600n; // an execution runs the passes due within this many seconds; HORIZON in sh/lib.sh
export const LAST_BLOCKS = 10; // a vote can land in each of these blocks before the flip
export const GRACE_MS = 60_000; // how long after the flip to wait for the block that ends it, and for the last receipt
const SAMPLE = 100n; // blocks over which the block interval is averaged
const POLL_MS = 100;

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

type Schedule = { times: bigint[]; last: boolean; note?: string };

/**
 * The passes this execution runs: the ones due ahead, or a missed one right now, or none. `last` when the flip is
 * within the horizon, so that it also votes on the last blocks.
 */
export function schedule(flip: bigint, offsets: bigint[], at: bigint, immediately: boolean): Schedule {
  if (immediately) return { times: [at], last: false };
  const last = flip > at && flip <= at + HORIZON;
  const times = passTimes(flip, offsets, at);
  if (!times.length && flip > at && missed(flip, offsets, at)) {
    return { times: [at], last, note: "running the missed pass now" };
  }
  if (times.length || last) return { times, last };
  return { times, last, note: `no pass due within ${HORIZON} s: flip at ${flip}, offsets ${offsets.join(",")}` };
}

export type Head = { number: bigint; timestamp: bigint };

/** Seconds per block, averaged over the last SAMPLE blocks. */
export async function blockInterval(client: Client): Promise<number> {
  const latest = await client.getBlock({ blockTag: "latest" });
  const earlier = await client.getBlock({ blockNumber: latest.number - SAMPLE });
  return Number(latest.timestamp - earlier.timestamp) / Number(SAMPLE);
}

/** Seconds before the flip within which a block is voted on: one more than LAST_BLOCKS, as a vote lands in the next. */
export const lastWindow = (interval: number) => (LAST_BLOCKS + 1) * interval;

/** When (ms) to start watching for the last blocks: two blocks early, as blocks appear late and unevenly. */
export const lastBlocksStart = (flip: bigint, interval: number) =>
  (Number(flip) - lastWindow(interval) - 2 * interval) * 1000;

/**
 * The new blocks within the last window, as they appear, until one at or after the flip, or GRACE_MS past it. Of the
 * blocks that appear while the consumer works, only the newest is yielded.
 */
export async function* lastBlocks(client: Client, flip: bigint, interval: number): AsyncGenerator<Head> {
  const end = Number(flip) * 1000 + GRACE_MS;
  let seen = 0n;
  while (Date.now() < end) {
    let head: Head;
    try {
      head = await client.getBlock({ blockTag: "latest" });
    } catch (error) {
      log.error("cannot read the latest block", { error: errorMessage(error) });
      await sleep(10 * POLL_MS);
      continue;
    }
    if (head.number > seen) {
      seen = head.number;
      if (head.timestamp >= flip) return;
      if (Number(flip - head.timestamp) <= lastWindow(interval)) yield head;
      continue;
    }
    await sleep(POLL_MS);
  }
}

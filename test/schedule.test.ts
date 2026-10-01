import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "../src/chain.ts";
import {
  blockInterval,
  GRACE_MS,
  lastBlocks,
  lastBlocksStart,
  missed,
  passTimes,
  schedule,
  type Head,
} from "../src/schedule.ts";

const flip = 1_790_812_800n;

test("pass times are the offsets due within the horizon, earliest first, deduplicated", () => {
  assert.deepEqual(passTimes(flip, [3600n, 600n, 60n], flip - 7200n), [flip - 3600n], "the rest is beyond the horizon");
  assert.deepEqual(
    passTimes(flip, [3600n, 600n, 60n], flip - 3600n),
    [flip - 600n, flip - 60n],
    "an offset exactly now is skipped",
  );
  assert.deepEqual(passTimes(flip, [60n, 60n, 600n], flip - 3600n), [flip - 600n, flip - 60n]);
  assert.deepEqual(passTimes(flip, [60n], flip), []);
  assert.deepEqual(
    passTimes(flip, [86400n, 600n, 5n], flip - 86400n - 600n),
    [flip - 86400n],
    "the day-before execution stops there",
  );
  assert.deepEqual(passTimes(flip, [86400n, 600n, 5n], flip - 1200n), [flip - 600n, flip - 5n]);
  assert.deepEqual(passTimes(flip, [86400n, 600n], flip - 86400n - 600n, 100_000n), [flip - 86400n, flip - 600n]);
});

test("missed tells a late start from a restart after the flip", () => {
  assert.equal(missed(flip, [600n, 5n], flip - 300n), true, "the 600 s pass was due 5 minutes ago");
  assert.equal(missed(flip, [600n, 5n], flip + 100n), true, "both passes were due within the last hour");
  assert.equal(missed(flip + 604800n, [86400n, 600n, 5n], flip + 100n), false, "next week's passes are not due");
  assert.equal(missed(flip, [86400n], flip - 3600n), false, "due exactly one horizon ago does not count");
});

test("schedule runs what is due, a missed pass right away, or nothing, and the last blocks near the flip", () => {
  const offsets = [86400n, 600n, 5n];
  assert.deepEqual(schedule(flip, offsets, flip - 1200n, false), { times: [flip - 600n, flip - 5n], last: true });
  assert.deepEqual(schedule(flip, offsets, flip - 1200n, true), { times: [flip - 1200n], last: false });
  assert.deepEqual(
    schedule(flip, offsets, flip - 86400n + 40n, false),
    { times: [flip - 86400n + 40n], last: false, note: "running the missed pass now" },
    "a restart 40 s after the day-before pass",
  );
  assert.deepEqual(
    schedule(flip, [86400n, 600n], flip - 300n, false),
    { times: [flip - 300n], last: true, note: "running the missed pass now" },
    "a restart after the 600 s pass also votes on the last blocks",
  );
  assert.deepEqual(schedule(flip, [86400n], flip - 1200n, false), { times: [], last: true }, "only the last blocks");
  assert.equal(schedule(flip, offsets, flip + 100n, false).times.length, 0, "a restart after the flip does nothing");
  assert.deepEqual(schedule(flip, offsets, flip - 7200n, false).times, [], "nothing due within the hour");
});

test("blockInterval averages the timestamps of the last hundred blocks", async () => {
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) =>
      blockNumber === undefined
        ? { number: 1000n, timestamp: 2000n }
        : { number: blockNumber, timestamp: 2000n - ((1000n - blockNumber) * 23n) / 10n },
  } as unknown as Client;
  assert.equal(await blockInterval(client), 2.3);
  assert.equal(lastBlocksStart(flip, 2), Number(flip) * 1000 - 26_000, "11 blocks of window and 2 of slack");
});

test("lastBlocks yields each new block of the last eleven, past stale polls and errors, until the flip", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(flip) * 1000 - 30_000 });
  const heads: (Head | Error)[] = [
    { number: 1n, timestamp: flip - 24n },
    { number: 2n, timestamp: flip - 22n },
    { number: 2n, timestamp: flip - 22n },
    new Error("502"),
    { number: 3n, timestamp: flip - 20n },
    { number: 5n, timestamp: flip - 1n },
    { number: 6n, timestamp: flip + 1n },
  ];
  const client = {
    getBlock: async () => {
      const head = heads.shift()!;
      if (head instanceof Error) throw head;
      return head;
    },
  } as unknown as Client;
  const seen: bigint[] = [];
  for await (const head of lastBlocks(client, flip, 2)) seen.push(head.number);
  assert.deepEqual(seen, [2n, 3n, 5n], "block 1 is too early, block 4 was never seen, block 6 is past the flip");
  assert.equal(heads.length, 0);
});

test("lastBlocks gives up a minute after the flip when no block reaches it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(flip) * 1000 });
  const client = {
    getBlock: async () => {
      t.mock.timers.setTime(Number(flip) * 1000 + GRACE_MS);
      return { number: 1n, timestamp: flip - 1n };
    },
  } as unknown as Client;
  const seen: bigint[] = [];
  for await (const head of lastBlocks(client, flip, 2)) seen.push(head.number);
  assert.deepEqual(seen, [1n]);
});

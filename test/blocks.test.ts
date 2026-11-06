import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "../src/chain.ts";
import { Blocks, watch } from "../src/blocks.ts";

const flip = 1_790_812_800_000;

/** Feeds `blocks` a first sighting of a block at each of `times` (ms), `seal` ms after its time. */
function feed(blocks: Blocks, times: number[], seal = 0) {
  times.forEach((time, k) => blocks.observe({ number: BigInt(k + 1), time }, time + seal));
  return times.at(-1)! + seal;
}

const every = (from: number, gap: number, count: number) => Array.from({ length: count }, (_, k) => from + k * gap);

function targets(blocks: Blocks, now: number) {
  const out: number[] = [];
  for (let t = blocks.next(flip, -Infinity, now); t !== undefined; t = blocks.next(flip, t, now)) out.push(t - flip);
  return out;
}

test("learns Base's timing: a block every 200 ms, each seen just before its time", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 10_000, 200, 30), -20);
  assert.deepEqual(blocks.timing, { gap: 200, seal: -20, lead: 200 + 20 + 200 });
});

test("votes once in each of the last two seconds, in the block before each second's last", () => {
  const blocks = new Blocks();
  const now = feed(blocks, every(flip - 10_000, 200, 30));
  assert.deepEqual(targets(blocks, now), [-1_400, -400]);
  assert.deepEqual(targets(blocks, flip - 1_401), [-1_400, -400], "while the first is being built");
  assert.deepEqual(targets(blocks, flip - 1_400), [-400], "once it is sealed");
  assert.deepEqual(targets(blocks, flip - 400), [], "never in a second's last block");
  assert.deepEqual(targets(blocks, flip + 1), [], "after the flip");
});

test("a vote is sent to reach the sequencer 200 ms before its block's build starts, when the block before is sealed", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 10_000, 200, 30), -100);
  const { gap, seal, lead } = blocks.timing;
  assert.equal(lead, gap - seal + 200);
  assert.equal(blocks.upcoming(flip, flip - 1_400 - lead - 1), flip - 1_400);
  assert.equal(blocks.upcoming(flip, flip - 1_400 - lead), flip - 400, "the first one's deadline passed");
  assert.equal(blocks.upcoming(flip, flip - 400 - lead), undefined);
});

test("blocks seen late, from a lagging RPC or a sequencer behind its schedule, never make a vote later", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 10_000, 200, 30), 300);
  assert.deepEqual(blocks.timing, { gap: 200, seal: 0, lead: 400 });
});

test("when polls stop, the block being built is extrapolated; before any poll, nothing is known", () => {
  const blocks = new Blocks();
  assert.equal(blocks.building(flip), undefined);
  assert.equal(blocks.next(flip, -Infinity, flip), undefined);
  assert.equal(blocks.upcoming(flip, flip), undefined);
  feed(blocks, every(flip - 10_000, 200, 30));
  assert.equal(blocks.building(flip - 3_001), flip - 3_000);
  assert.equal(blocks.building(flip - 3_000), flip - 2_800, "sealed");
  assert.deepEqual(targets(blocks, flip - 3_000), [-1_400, -400]);
});

test("a sighting by a slow poll doesn't time the seal: the block could have been seen anywhere in that poll", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 10_000, 200, 30), -20);
  blocks.observe({ number: 31n, time: flip - 4_000 }, flip - 4_225, 450);
  assert.equal(blocks.timing.seal, -20, "a 450 ms poll");
  blocks.observe({ number: 32n, time: flip - 3_800 }, flip - 3_850, 80);
  assert.equal(blocks.timing.seal, -50, "an 80 ms poll");
});

test("a late answer about an older block, or a block seen again, is ignored", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 10_000, 200, 30));
  const before = blocks.timing;
  blocks.observe({ number: 29n, time: flip - 4_400 }, flip - 9_000);
  blocks.observe({ number: 30n, time: flip - 4_200 }, flip - 9_000);
  assert.deepEqual(blocks.timing, before);
});

test("the latest block is polled; a failed, hung, malformed or unstamped poll is skipped", async () => {
  const answers = [
    () => Promise.reject(new Error("HTTP 503")),
    () => new Promise(() => {}),
    async () => ({ number: "0x1", timestamp: "0x6abd8f7f" }),
    async () => ({ number: "0x2", timestamp: "0x6abd8f80", timestampMs: "not a number" }),
    async () => null,
    async () => ({ number: "0x3", timestamp: "0x6abd8f81", timestampMs: "0x1a0e44c0ec8", transactions: ["0xab"] }),
  ];
  const tags: unknown[] = [];
  let polls = 0;
  const request = ({ params }: { params: unknown[] }) => (tags.push(params[0]), answers[polls++]!());
  const blocks = new Blocks();
  await watch({ request } as unknown as Client, blocks, () => polls === answers.length);
  assert.equal(blocks.building(0), 0x1a0e44c0ec8);
  assert.ok(tags.every((tag) => tag === "latest"));
});

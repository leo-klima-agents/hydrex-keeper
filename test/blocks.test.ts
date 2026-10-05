import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "../src/chain.ts";
import { Blocks, watch } from "../src/blocks.ts";

const flip = 1_790_812_800_000;

type Chain = { gap?: number; seal?: number; subBlocks?: number; leeway?: number };

/**
 * Polls of blocks with the timestamps `times` (ms), each built from the previous one's seal, `seal` after its
 * timestamp, in `subBlocks` sub-blocks, the last one `leeway` before its seal. Returns when the last block started.
 */
function feed(blocks: Blocks, times: number[], { seal = 0, subBlocks = 10, leeway = 450 }: Chain = {}) {
  times.forEach((time, k) => {
    const number = BigInt(k + 1);
    const start = (k ? times[k - 1]! : time - 2_000) + seal;
    const last = time + seal - leeway;
    for (let i = 0; i <= subBlocks; i++) {
      blocks.observe(
        { number, timestamp: BigInt(time / 1000), txs: 1 + i },
        start + ((last - start) * i) / (subBlocks || 1),
      );
    }
  });
  return (times.at(-2) ?? times.at(-1)! - 2_000) + seal;
}

const every = (from: number, gap: number, count: number) => Array.from({ length: count }, (_, k) => from + k * gap);

/** The blocks voted in, from `now` on. */
function targets(blocks: Blocks, now: number) {
  const out: number[] = [];
  for (let t = blocks.next(flip, -Infinity, now); t !== undefined; t = blocks.next(flip, t, now)) out.push(t - flip);
  return out;
}

test("learns Base's timing: two-second blocks, the last sub-block 450 ms before the timestamp", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 61_000, 2_000, 10));
  assert.deepEqual(blocks.timing, { gap: 2_000, maxGap: 2_000, seal: 0, lead: 155 + 200 + 450 });
});

test("votes in the last two blocks before the flip, whether timestamps fall on odd or even seconds", () => {
  const odd = new Blocks();
  assert.deepEqual(targets(odd, feed(odd, every(flip - 61_000, 2_000, 10))), [-3_000, -1_000]);
  const even = new Blocks();
  assert.deepEqual(targets(even, feed(even, every(flip - 60_000, 2_000, 10))), [-4_000, -2_000]);
  assert.deepEqual(targets(even, flip - 3_000), [-2_000], "once the second-to-last is sealed");
  assert.deepEqual(targets(even, flip + 1), [], "after the flip");
});

test("the deadline follows the seal wherever it falls within the second", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 61_000, 2_000, 10), { seal: 300 });
  const { lead, seal } = blocks.timing;
  assert.equal(seal, 300);
  assert.equal(-lead, 300 - 450 - 155 - 200, "a margin before the last sub-block starts");
});

test("with irregular gaps, votes in every block that may be one of the last two", () => {
  const blocks = new Blocks();
  const now = feed(blocks, [...every(flip - 21_000, 2_000, 7), flip - 5_000]);
  assert.deepEqual(blocks.timing.maxGap, 4_000);
  assert.deepEqual(targets(blocks, now), [-5_000, -3_000, -1_000]);
});

test("without sub-blocks, a vote goes half a gap before the timestamp", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 61_000, 2_000, 10), { subBlocks: 0 });
  assert.deepEqual(blocks.timing, { gap: 2_000, maxGap: 2_000, seal: 0, lead: 1_000 });
});

test("when polls stop, the block being built is extrapolated; before any poll, nothing is known", () => {
  const blocks = new Blocks();
  assert.equal(blocks.building(flip), undefined);
  assert.equal(blocks.next(flip, -Infinity, flip), undefined);
  feed(blocks, every(flip - 61_000, 2_000, 10));
  assert.equal(blocks.building(flip - 43_001), flip - 43_000);
  assert.equal(blocks.building(flip - 43_000), flip - 41_000, "sealed");
  assert.deepEqual(targets(blocks, flip - 10_000), [-3_000, -1_000]);
});

test("a late answer about an older block, or about fewer transactions, is ignored", () => {
  const blocks = new Blocks();
  feed(blocks, every(flip - 61_000, 2_000, 10));
  const before = blocks.timing;
  blocks.observe({ number: 9n, timestamp: BigInt((flip - 45_000) / 1000), txs: 99 }, flip - 40_000);
  blocks.observe({ number: 10n, timestamp: BigInt((flip - 43_000) / 1000), txs: 2 }, flip - 40_000);
  assert.deepEqual(blocks.timing, before);
});

test("a failed, hung or malformed poll is skipped", async () => {
  const answers = [
    () => Promise.reject(new Error("HTTP 503")),
    () => new Promise(() => {}),
    async () => ({ number: "0x1", timestamp: "0x6abd8f7f" }),
    async () => null,
    async () => ({ number: "0x2", timestamp: "0x6abd8f81", transactions: ["0xab"] }),
  ];
  let polls = 0;
  const client = { request: () => answers[polls++]!() } as unknown as Client;
  const blocks = new Blocks();
  await watch(client, blocks, () => polls === answers.length);
  assert.equal(blocks.building(0), 0x6abd8f81 * 1000);
});

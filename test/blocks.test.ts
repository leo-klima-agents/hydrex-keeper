import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAt, LEAD_MS, median, sealAt, slots, timing, type Seen } from "../src/blocks.ts";

const flip = 1_790_812_800;

/** Blocks first seen when the previous one sealed, `skew` ms after its timestamp, a round trip later. */
const seen = (timestamps: number[], skew: number, spacing = 2, rtt = 160): Seen[] =>
  timestamps.map((timestamp) => ({ timestamp, seen: (timestamp - spacing) * 1000 + skew + rtt, rtt }));

test("median is the upper middle, or undefined of nothing", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 3);
});

test("timing defaults to 2 s blocks of unknown phase sealing on their timestamp", () => {
  assert.deepEqual(timing({ seeds: [], seen: [], rtts: [] }), { spacing: 2, phase: undefined, skew: 0, rtt: 200 });
  assert.equal(timing({ seeds: [flip - 7], seen: [], rtts: [50] }).phase, 1, "a seed gives the phase");
});

test("timing takes the spacing, phase and skew from the blocks seen, ignoring one odd gap", () => {
  const t = timing({ seeds: [flip - 21], seen: seen([flip - 19, flip - 17, flip - 11, flip - 9], 70), rtts: [160] });
  assert.deepEqual(t, { spacing: 2, phase: 1, skew: 70, rtt: 160 });
  const odd = timing({ seeds: [], seen: seen([flip - 20, flip - 19, flip - 18], -40, 1), rtts: [120, 200, 150] });
  assert.deepEqual(odd, { spacing: 1, phase: 0, skew: -40, rtt: 150 });
});

test("slots are the two last blocks before the flip, or the earliest they could be", () => {
  assert.deepEqual(slots(flip, { spacing: 2, phase: 1, skew: 0, rtt: 0 }), [flip - 3, flip - 1]);
  assert.deepEqual(slots(flip, { spacing: 2, phase: 0, skew: 0, rtt: 0 }), [flip - 4, flip - 2]);
  assert.deepEqual(slots(flip, { spacing: 2, phase: undefined, skew: 0, rtt: 0 }), [flip - 4, flip - 2]);
  assert.deepEqual(slots(flip, { spacing: 1, phase: 0, skew: 0, rtt: 0 }), [flip - 2, flip - 1]);
  assert.deepEqual(slots(flip, { spacing: 3, phase: 2, skew: 0, rtt: 0 }), [flip - 4, flip - 1]);
  assert.deepEqual(slots(flip, { spacing: 3, phase: undefined, skew: 0, rtt: 0 }), [flip - 6, flip - 3]);
});

test("a block is decided its pipeline and a lead before it seals", () => {
  const t = { spacing: 2, phase: 1, skew: 250, rtt: 150 };
  assert.equal(sealAt(flip - 1, t), (flip - 1) * 1000 + 250);
  assert.equal(decideAt(flip - 1, t, 400), (flip - 1) * 1000 + 250 - LEAD_MS - 400 - 150);
});

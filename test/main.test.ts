import assert from "node:assert/strict";
import { test } from "node:test";
import { passTimes } from "../src/main.ts";
import { sameVote } from "../src/vote.ts";

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";

test("pass times are the offsets due within the horizon, earliest first, deduplicated", () => {
  const flip = 1_790_812_800n;
  assert.deepEqual(passTimes(flip, [3600n, 600n, 60n], flip - 7200n), [flip - 3600n], "the rest is beyond the horizon");
  assert.deepEqual(passTimes(flip, [3600n, 600n, 60n], flip - 3600n), [flip - 600n, flip - 60n], "an offset exactly now is skipped");
  assert.deepEqual(passTimes(flip, [60n, 60n, 600n], flip - 3600n), [flip - 600n, flip - 60n]);
  assert.deepEqual(passTimes(flip, [60n], flip), []);
  assert.deepEqual(passTimes(flip, [86400n, 600n, 5n], flip - 86400n - 600n), [flip - 86400n], "the day-before execution stops there");
  assert.deepEqual(passTimes(flip, [86400n, 600n, 5n], flip - 1200n), [flip - 600n, flip - 5n]);
  assert.deepEqual(passTimes(flip, [86400n, 600n], flip - 86400n - 600n, 100_000n), [flip - 86400n, flip - 600n]);
});

test("sameVote compares pools case-insensitively and in order", () => {
  assert.equal(sameVote([A], { pools: [A.toUpperCase() as typeof A], weights: [100n] }), true);
  assert.equal(sameVote([A, B], { pools: [B, A], weights: [1n, 1n] }), false);
  assert.equal(sameVote([], { pools: [A], weights: [100n] }), false);
});

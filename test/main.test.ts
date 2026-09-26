import assert from "node:assert/strict";
import { test } from "node:test";
import { missed, passTimes, schedule } from "../src/main.ts";
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

test("sameVote compares pools case-insensitively, in order, with the Voter's derived weights", () => {
  assert.equal(sameVote({ pools: [A], votes: [1000n] }, { pools: [A.toUpperCase() as typeof A], weights: [100n] }, 1000n), true);
  assert.equal(sameVote({ pools: [A, B], votes: [500n, 500n] }, { pools: [B, A], weights: [1n, 1n] }, 1000n), false);
  assert.equal(sameVote({ pools: [], votes: [] }, { pools: [A], weights: [100n] }, 1000n), false);
  assert.equal(sameVote({ pools: [A, B], votes: [900n, 100n] }, { pools: [A, B], weights: [50n, 50n] }, 1000n), false, "same pools, other split");
  assert.equal(sameVote({ pools: [A, B], votes: [333n, 666n] }, { pools: [A, B], weights: [1n, 2n] }, 1000n), true, "integer division as in the Voter");
});

test("missed tells a late start from a restart after the flip", () => {
  const flip = 1_790_812_800n;
  assert.equal(missed(flip, [600n, 5n], flip - 300n), true, "the 600 s pass was due 5 minutes ago");
  assert.equal(missed(flip, [600n, 5n], flip + 100n), true, "both passes were due within the last hour");
  assert.equal(missed(flip + 604800n, [86400n, 600n, 5n], flip + 100n), false, "next week's passes are not due");
  assert.equal(missed(flip, [86400n], flip - 3600n), false, "due exactly one horizon ago does not count");
});

test("schedule runs what is due, a missed pass right away, or nothing", () => {
  const flip = 1_790_812_800n;
  const offsets = [86400n, 600n, 5n];
  assert.deepEqual(schedule(flip, offsets, flip - 1200n, false), { times: [flip - 600n, flip - 5n] });
  assert.deepEqual(schedule(flip, offsets, flip - 1200n, true), { times: [flip - 1200n] });
  assert.deepEqual(schedule(flip, offsets, flip - 86400n + 40n, false), { times: [flip - 86400n + 40n], note: "running the missed pass now" }, "a restart 40 s after the day-before pass");
  assert.equal(schedule(flip, offsets, flip + 100n, false).times.length, 0, "a restart after the flip does nothing");
  assert.equal(schedule(flip, offsets, flip - 7200n, false).times.length, 0, "nothing due within the hour");
});

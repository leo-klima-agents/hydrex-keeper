import assert from "node:assert/strict";
import { test } from "node:test";
import { everyBlockStart, missed, modeAt, passTimes, schedule } from "../src/schedule.ts";

const flip = 1_790_812_800n;
const offsets = [86400n, 60n];
const everyBlockFrom = 10n;

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
    passTimes(flip, offsets, flip - 86400n - 600n),
    [flip - 86400n],
    "the day-before execution stops there",
  );
  assert.deepEqual(passTimes(flip, offsets, flip - 1200n), [flip - 60n]);
  assert.deepEqual(passTimes(flip, offsets, flip - 86400n - 600n, 100_000n), [flip - 86400n, flip - 60n]);
});

test("missed tells a late start from a restart after the flip", () => {
  assert.equal(missed(flip, [600n, 5n], flip - 300n), true, "the 600 s pass was due 5 minutes ago");
  assert.equal(missed(flip, [600n, 5n], flip + 100n), true, "both passes were due within the last hour");
  assert.equal(missed(flip + 604800n, offsets, flip + 100n), false, "next week's passes are not due");
  assert.equal(missed(flip, [86400n], flip - 3600n), false, "due exactly one horizon ago does not count");
});

test("the pass on every block starts when due within the horizon, or at once if already due, never after the flip", () => {
  assert.equal(everyBlockStart(flip, everyBlockFrom, flip - 1200n), flip - 10n);
  assert.equal(everyBlockStart(flip, everyBlockFrom, flip - 5n), flip - 5n, "a restart inside the window");
  assert.equal(everyBlockStart(flip, everyBlockFrom, flip - 7200n), undefined, "beyond the horizon");
  assert.equal(everyBlockStart(flip, everyBlockFrom, flip - 3610n), flip - 10n, "just within it");
  assert.equal(everyBlockStart(flip, everyBlockFrom, flip), undefined);
});

test("schedule runs what is due, a missed pass right away, or nothing", () => {
  assert.deepEqual(
    schedule(flip, offsets, everyBlockFrom, flip - 1200n, false),
    { times: [flip - 60n], everyBlock: flip - 10n },
    "the execution before the flip",
  );
  assert.deepEqual(
    schedule(flip, offsets, everyBlockFrom, flip - 86400n - 600n, false),
    { times: [flip - 86400n] },
    "the day-before execution: no pass on every block",
  );
  assert.deepEqual(schedule(flip, offsets, everyBlockFrom, flip - 1200n, true), { times: [flip - 1200n] });
  assert.deepEqual(
    schedule(flip, offsets, everyBlockFrom, flip - 5n, false),
    { times: [], everyBlock: flip - 5n },
    "a restart inside the window",
  );
  assert.deepEqual(
    schedule(flip, offsets, everyBlockFrom, flip + 30n, false),
    { times: [], everyBlock: flip + 30n, note: "restarted after the flip; finishing the post-flip vote" },
    "a restart after the flip",
  );
  assert.deepEqual(
    schedule(flip, offsets, everyBlockFrom, flip - 86400n + 40n, false),
    { times: [flip - 86400n + 40n], note: "running the missed pass now" },
    "a restart 40 s after the day-before pass",
  );
  assert.equal(
    schedule(flip, offsets, everyBlockFrom, flip - 7200n, false).times.length,
    0,
    "nothing due within the hour",
  );
});

test("passes vote proportionally far from the flip and after it, for the best expected reward in between", () => {
  assert.equal(modeAt(flip - 86400n, flip), "proportional");
  assert.equal(modeAt(flip - 3601n, flip), "proportional");
  assert.equal(modeAt(flip - 3600n, flip), "optimal");
  assert.equal(modeAt(flip - 60n, flip), "optimal");
  assert.equal(modeAt(flip - 1n, flip), "optimal", "the last block before the flip");
  assert.equal(modeAt(flip + 1n, flip), "proportional", "the flip block");
  assert.equal(modeAt(flip + 17n, flip), "proportional");
});

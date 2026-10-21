import assert from "node:assert/strict";
import { test } from "node:test";
import { WEEK } from "../src/chain.ts";
import { DAY, due, HORIZON, task, type Start } from "../src/schedule.ts";

const flip = 1_790_812_800n;

test("an execution votes a day before the flip, or in its last blocks, or does nothing", () => {
  assert.equal(due(flip, flip - DAY - 600n), "day before", "started ten minutes ahead");
  assert.equal(due(flip, flip - DAY + 40n), "day before", "restarted 40 s after");
  assert.equal(due(flip, flip - DAY - HORIZON), undefined, "an hour ahead is too early");
  assert.equal(due(flip, flip - DAY + HORIZON), undefined, "an hour after is too late");
  assert.equal(due(flip, flip - 1200n), "last blocks");
  assert.equal(due(flip, flip - HORIZON), "last blocks");
  assert.equal(due(flip, flip - HORIZON - 1n), undefined);
});

test("in the hour after a flip, an execution claims, whether the minter has started the epoch or not", () => {
  assert.equal(due(flip, flip), "claims", "the minter has not started it yet");
  assert.equal(due(flip, flip + 100n), "claims");
  assert.equal(due(flip, flip + HORIZON - 1n), "claims");
  assert.equal(due(flip, flip + HORIZON), undefined);
  assert.equal(due(flip + WEEK, flip + 100n), "claims", "the minter has started it");
  assert.equal(due(flip + WEEK, flip + HORIZON), undefined);
});

const start = (more: Partial<Start> = {}): Start => ({
  now: false,
  claim: false,
  dryRun: false,
  retry: false,
  ...more,
});

test("--now and --claim are refused while the schedule may be sending, unless in a dry run", () => {
  for (const at of [flip - DAY, flip - 600n, flip + 60n]) {
    assert.throws(() => task(flip, at, start({ now: true })), /--now would race the scheduled/);
    assert.throws(() => task(flip, at, start({ claim: true })), /--claim would race the scheduled/);
    assert.equal(task(flip, at, start({ now: true, dryRun: true })).what, "day before");
    assert.equal(task(flip, at, start({ claim: true, dryRun: true })).what, "claims");
  }
  assert.deepEqual(task(flip, flip - 2n * DAY, start({ now: true })), { what: "day before", recheck: false });
  assert.deepEqual(task(flip, flip - 2n * DAY, start({ claim: true })), { what: "claims", recheck: false });
});

test("a retry of the vote of a day before leaves out a conduit whose vote is in; a first attempt or --now does not", () => {
  assert.deepEqual(task(flip, flip - DAY, start()), { what: "day before", recheck: false });
  assert.deepEqual(task(flip, flip - DAY, start({ retry: true })), { what: "day before", recheck: true });
  const now = start({ now: true, retry: true });
  assert.deepEqual(task(flip, flip - 2n * DAY, now), { what: "day before", recheck: false });
});

test("with nothing due, a retry succeeds, and a first attempt fails so that a schedule that misses its window alerts", () => {
  assert.deepEqual(task(flip, flip - 2n * DAY, start({ retry: true })), { what: undefined, exit: 0 });
  assert.deepEqual(task(flip, flip - 2n * DAY, start()), { what: undefined, exit: 1 });
  assert.deepEqual(
    task(flip, flip + HORIZON + 60n, start({ retry: true })),
    { what: undefined, exit: 0 },
    "the minter lags",
  );
});

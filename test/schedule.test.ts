import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY, due, HORIZON } from "../src/schedule.ts";

const flip = 1_790_812_800n;

test("an execution votes a day before the flip, or in its last blocks, or does nothing", () => {
  assert.equal(due(flip, flip - DAY - 600n), "day before", "started ten minutes ahead");
  assert.equal(due(flip, flip - DAY + 40n), "day before", "restarted 40 s after");
  assert.equal(due(flip, flip - DAY - HORIZON), undefined, "an hour ahead is too early");
  assert.equal(due(flip, flip - DAY + HORIZON), undefined, "an hour after is too late");
  assert.equal(due(flip, flip - 1200n), "last blocks");
  assert.equal(due(flip, flip - HORIZON), "last blocks");
  assert.equal(due(flip, flip - HORIZON - 1n), undefined);
  assert.equal(due(flip, flip), undefined, "at the flip");
  assert.equal(due(flip, flip + 100n), undefined);
});

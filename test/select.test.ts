import assert from "node:assert/strict";
import { test } from "node:test";
import { select } from "../src/select.ts";

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";

test("picks the pool with the best expected share, not the biggest pot", () => {
  // A pays 100 with 900 other votes; B pays 50 with 0 other votes. With power 100:
  // A yields 100 * 100/1000 = 10, B yields 50 * 100/100 = 50.
  const vote = select(
    [
      { pool: A, rewardsUsd: 100, otherVotes: 900n },
      { pool: B, rewardsUsd: 50, otherVotes: 0n },
    ],
    100n,
  );
  assert.deepEqual(vote, { pools: [B], weights: [100n] });
});

test("ties keep the earlier candidate", () => {
  const vote = select(
    [
      { pool: A, rewardsUsd: 10, otherVotes: 10n },
      { pool: B, rewardsUsd: 10, otherVotes: 10n },
    ],
    10n,
  );
  assert.deepEqual(vote?.pools, [A]);
});

test("null when nothing pays", () => {
  assert.equal(select([{ pool: A, rewardsUsd: 0, otherVotes: 0n }], 10n), null);
  assert.equal(select([], 10n), null);
});

test("works with 1e18-scale votes", () => {
  const power = 897_081_627_439_923_405_444_321n;
  const vote = select(
    [
      { pool: A, rewardsUsd: 60_000, otherVotes: 7_731_347_235_068_989_759_707_677n },
      { pool: B, rewardsUsd: 20_000, otherVotes: 104_926_137_216_706_515_281_128n },
    ],
    power,
  );
  assert.deepEqual(vote?.pools, [B]); // 20000 * 0.9 / 1.0 > 60000 * 0.9 / 8.6
});

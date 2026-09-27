import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { allocate, expected, select } from "../src/select.ts";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;
const none = { pools: [], votes: [] };

/** Best expected value over a fine grid of splits between two pools. */
function gridBest(candidates: Parameters<typeof allocate>[0], power: bigint): number {
  let best = 0;
  for (let k = 0; k <= 10_000; k++) best = Math.max(best, expected(candidates, [k / 10_000, 1 - k / 10_000], power));
  return best;
}

test("water-filling matches a brute-force optimum for two pools", () => {
  const candidates = [
    { pool: A, rewardsUsd: 4_300, otherVotes: 7_900_000n * 10n ** 18n },
    { pool: B, rewardsUsd: 1_500, otherVotes: 1_150_000n * 10n ** 18n },
  ];
  const power = 897_000n * 10n ** 18n;
  const x = allocate(candidates, power)!;
  assert.ok(Math.abs(x[0]! + x[1]! - 1) < 1e-9);
  assert.ok(expected(candidates, x, power) >= gridBest(candidates, power) - 0.01);
  assert.ok(x[1]! > x[0]!, "the less crowded pool gets more");
});

test("all power goes to the only paying pool; nothing pays gives null", () => {
  assert.deepEqual(allocate([{ pool: A, rewardsUsd: 0, otherVotes: 10n }, { pool: B, rewardsUsd: 5, otherVotes: 10n }], 100n), [0, 1]);
  assert.equal(allocate([{ pool: A, rewardsUsd: 0, otherVotes: 10n }], 100n), null);
  assert.equal(select([], 100n, none), null);
});

test("equal pools split equally and weights are basis points", () => {
  const candidates = [{ pool: A, rewardsUsd: 10, otherVotes: 100n }, { pool: B, rewardsUsd: 10, otherVotes: 100n }, { pool: C, rewardsUsd: 0, otherVotes: 1n }];
  assert.deepEqual(select(candidates, 50n, none)?.vote, { pools: [A, B], weights: [5000n, 5000n] });
});

test("a pool nobody voted for gets a small share, not everything", () => {
  const x = allocate([{ pool: A, rewardsUsd: 100, otherVotes: 0n }, { pool: B, rewardsUsd: 100, otherVotes: 1000n }], 1000n)!;
  assert.ok(x[0]! > 0 && x[0]! < 0.2, `got ${x[0]}`);
});

test("shares below a tenth of a percent are dropped and the rest re-solved", () => {
  const x = allocate([{ pool: A, rewardsUsd: 1000, otherVotes: 1000n }, { pool: B, rewardsUsd: 1, otherVotes: 1000n }], 1000n)!;
  assert.deepEqual(x, [1, 0]);
  const y = allocate([{ pool: A, rewardsUsd: 1000, otherVotes: 1000n }, { pool: B, rewardsUsd: 1000, otherVotes: 1000n }, { pool: C, rewardsUsd: 0.5, otherVotes: 1000n }], 1000n)!;
  assert.deepEqual(y.map((f) => Math.round(f * 100)), [50, 50, 0]);
});

test("keeps the current vote unless the gain is at least one percent", () => {
  const candidates = [{ pool: A, rewardsUsd: 10, otherVotes: 100n }, { pool: B, rewardsUsd: 10, otherVotes: 100n }];
  assert.equal(select(candidates, 50n, { pools: [A, B], votes: [25n, 25n] })?.better, false, "already optimal");
  assert.equal(select(candidates, 50n, { pools: [A, B], votes: [26n, 24n] })?.better, false, "within one percent");
  assert.equal(select(candidates, 50n, { pools: [A], votes: [50n] })?.better, true, "clearly better");
  assert.equal(select(candidates, 50n, none)?.better, true, "first vote of the epoch");
});

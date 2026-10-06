import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { expected, proportional, select, waterFill, type Candidate } from "../src/select.ts";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;

const candidate = (pool: Address, rewardsUsd: number, otherVotes: bigint, ownVotes = 0n): Candidate => ({
  pool,
  rewardsUsd,
  otherVotes,
  ownVotes,
});

/** Best expected value over a fine grid of splits between two pools. */
function gridBest(candidates: Candidate[], power: bigint): number {
  let best = 0;
  for (let k = 0; k <= 10_000; k++) best = Math.max(best, expected(candidates, [k / 10_000, 1 - k / 10_000], power));
  return best;
}

test("water-filling matches a brute-force optimum for two pools", () => {
  const candidates = [candidate(A, 4_300, 7_900_000n * 10n ** 18n), candidate(B, 1_500, 1_150_000n * 10n ** 18n)];
  const power = 897_000n * 10n ** 18n;
  const x = waterFill(candidates, power)!;
  assert.ok(Math.abs(x[0]! + x[1]! - 1) < 1e-9);
  assert.ok(expected(candidates, x, power) >= gridBest(candidates, power) - 0.01);
  assert.ok(x[1]! > x[0]!, "the less crowded pool gets more");
});

test("all power goes to the only paying pool; nothing pays gives null", () => {
  assert.deepEqual(waterFill([candidate(A, 0, 10n), candidate(B, 5, 10n)], 100n), [0, 1]);
  assert.equal(waterFill([candidate(A, 0, 10n)], 100n), null);
  assert.deepEqual(select([], 100n, waterFill), { fractions: null, vote: null });
});

test("equal pools split equally and weights are basis points", () => {
  const candidates = [candidate(A, 10, 100n), candidate(B, 10, 100n), candidate(C, 0, 1n)];
  const { fractions, vote } = select(candidates, 50n, waterFill);
  assert.deepEqual(vote, { pools: [A, B], weights: [5000n, 5000n] });
  assert.deepEqual(fractions, waterFill(candidates, 50n), "the allocation it voted from");
});

test("a pool nobody voted for gets a small share, not everything", () => {
  const x = waterFill([candidate(A, 100, 0n), candidate(B, 100, 1000n)], 1000n)!;
  assert.ok(x[0]! > 0 && x[0]! < 0.2, `got ${x[0]}`);
});

test("shares below a tenth of a percent are dropped and the rest re-solved", () => {
  assert.deepEqual(waterFill([candidate(A, 1000, 1000n), candidate(B, 1, 1000n)], 1000n), [1, 0]);
  const y = waterFill([candidate(A, 1000, 1000n), candidate(B, 1000, 1000n), candidate(C, 0.5, 1000n)], 1000n)!;
  const percents = y.map((f) => Math.round(f * 100));
  assert.deepEqual(percents, [50, 50, 0]);
});

test("keeps the current vote unless the gain is at least one percent", () => {
  const voted = (a: bigint, b: bigint) =>
    select([candidate(A, 10, 100n, a), candidate(B, 10, 100n, b)], 50n, waterFill).vote;
  assert.equal(voted(25n, 25n), null, "already optimal");
  assert.equal(voted(26n, 24n), null, "within one percent");
  assert.deepEqual(voted(50n, 0n), { pools: [A, B], weights: [5000n, 5000n] }, "clearly better");
  assert.deepEqual(voted(0n, 0n)?.weights, [5000n, 5000n], "first vote of the epoch");
});

/** `n` pools paying 1, 2, ... n, each with 100 votes from others. */
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => candidate(`0x${(i + 1).toString(16).padStart(40, "0")}` as Address, i + 1, 100n));

test("a vote names at most the 40 pools with the largest shares", () => {
  const x = waterFill(many(50), 1_000_000n)!;
  assert.equal(x.filter((xi) => xi > 0).length, 40);
  assert.ok(
    x.slice(0, 10).every((xi) => xi === 0),
    "the smallest are dropped",
  );
  const tied = waterFill(
    Array.from({ length: 50 }, () => candidate(A, 1, 100n)),
    1_000n,
  )!;
  assert.deepEqual(
    tied.filter((xi) => xi > 0),
    Array<number>(40).fill(1 / 40),
    "ties do not drop them all",
  );
});

test("proportional shares follow the rewards alone, without the smallest", () => {
  assert.deepEqual(
    proportional([candidate(A, 30, 1_000_000n), candidate(B, 10, 0n), candidate(C, 0, 0n)]),
    [0.75, 0.25, 0],
  );
  assert.deepEqual(proportional([candidate(A, 9_995, 0n), candidate(B, 5, 0n)]), [1, 0], "under 0.1% is dropped");
  assert.equal(proportional([candidate(A, 0, 0n)]), null);
  const x = proportional(many(50))!;
  assert.equal(x.filter((xi) => xi > 0).length, 40);
  assert.ok(Math.abs(x[49]! / x[10]! - 50 / 11) < 1e-9, "the rest keep their proportions");
});

test("a proportional vote is cast once: casting it again does not pay one percent more", () => {
  const voted = (a: bigint, b: bigint) =>
    select([candidate(A, 30, 100n, a), candidate(B, 10, 100n, b)], 100n, proportional).vote;
  assert.deepEqual(voted(0n, 0n), { pools: [A, B], weights: [7500n, 2500n] });
  assert.equal(voted(75n, 25n), null);
});

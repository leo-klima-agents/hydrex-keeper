import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { allocate, expected, select, type Candidate } from "../src/select.ts";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;

const candidate = (pool: Address, rewardsUsd: number, otherVotes: bigint, ownVotes = 0n): Candidate => ({ pool, rewardsUsd, otherVotes, ownVotes });

/** Best expected value over a fine grid of splits between two pools. */
function gridBest(candidates: Candidate[], power: bigint): number {
  let best = 0;
  for (let k = 0; k <= 10_000; k++) best = Math.max(best, expected(candidates, [k / 10_000, 1 - k / 10_000], power));
  return best;
}

test("water-filling matches a brute-force optimum for two pools", () => {
  const candidates = [candidate(A, 4_300, 7_900_000n * 10n ** 18n), candidate(B, 1_500, 1_150_000n * 10n ** 18n)];
  const power = 897_000n * 10n ** 18n;
  const x = allocate(candidates, power)!;
  assert.ok(Math.abs(x[0]! + x[1]! - 1) < 1e-9);
  assert.ok(expected(candidates, x, power) >= gridBest(candidates, power) - 0.01);
  assert.ok(x[1]! > x[0]!, "the less crowded pool gets more");
});

test("all power goes to the only paying pool; nothing pays gives null", () => {
  assert.deepEqual(allocate([candidate(A, 0, 10n), candidate(B, 5, 10n)], 100n), [0, 1]);
  assert.equal(allocate([candidate(A, 0, 10n)], 100n), null);
  assert.deepEqual(select([], 100n), { fractions: null, vote: null });
});

test("equal pools split equally and weights are basis points", () => {
  const candidates = [candidate(A, 10, 100n), candidate(B, 10, 100n), candidate(C, 0, 1n)];
  const { fractions, vote } = select(candidates, 50n);
  assert.deepEqual(vote, { pools: [A, B], weights: [5000n, 5000n] });
  assert.deepEqual(fractions, allocate(candidates, 50n), "the allocation it voted from");
});

test("a pool nobody voted for gets a small share, not everything", () => {
  const x = allocate([candidate(A, 100, 0n), candidate(B, 100, 1000n)], 1000n)!;
  assert.ok(x[0]! > 0 && x[0]! < 0.2, `got ${x[0]}`);
});

test("shares below a tenth of a percent are dropped and the rest re-solved", () => {
  assert.deepEqual(allocate([candidate(A, 1000, 1000n), candidate(B, 1, 1000n)], 1000n), [1, 0]);
  const y = allocate([candidate(A, 1000, 1000n), candidate(B, 1000, 1000n), candidate(C, 0.5, 1000n)], 1000n)!;
  assert.deepEqual(y.map((f) => Math.round(f * 100)), [50, 50, 0]);
});

test("keeps the current vote unless the gain is at least one percent", () => {
  const voted = (a: bigint, b: bigint) => select([candidate(A, 10, 100n, a), candidate(B, 10, 100n, b)], 50n).vote;
  assert.equal(voted(25n, 25n), null, "already optimal");
  assert.equal(voted(26n, 24n), null, "within one percent");
  assert.deepEqual(voted(50n, 0n), { pools: [A, B], weights: [5000n, 5000n] }, "clearly better");
  assert.deepEqual(voted(0n, 0n)?.weights, [5000n, 5000n], "first vote of the epoch");
});

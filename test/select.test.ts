import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import {
  asVoted,
  expected,
  gain,
  proportional,
  score,
  select,
  summarize,
  toVote,
  waterFill,
  waterFillAbove,
  type Candidate,
} from "../src/select.ts";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;

const candidate = (pool: Address, rewardsUsd: number, otherVotes: bigint, ownVotes = 0n): Candidate => ({
  pool,
  rewardsUsd,
  otherVotes,
  ownVotes,
});

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
  assert.deepEqual(select([], 100n), { fractions: null, vote: null });
});

test("equal pools split equally and weights are basis points", () => {
  const candidates = [candidate(A, 10, 100n), candidate(B, 10, 100n), candidate(C, 0, 1n)];
  const { fractions, vote } = select(candidates, 50n);
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

test("keeps the current vote unless the gain is at least a dollar", () => {
  const voted = (a: bigint, b: bigint) => select([candidate(A, 1000, 100n, a), candidate(B, 1000, 100n, b)], 50n).vote;
  assert.equal(voted(25n, 25n), null, "already optimal");
  assert.equal(voted(28n, 22n), null, "within a dollar");
  assert.deepEqual(voted(29n, 21n), { pools: [A, B], weights: [5000n, 5000n] }, "over a dollar");
  assert.deepEqual(voted(50n, 0n), { pools: [A, B], weights: [5000n, 5000n] }, "clearly better");
  assert.deepEqual(voted(0n, 0n)?.weights, [5000n, 5000n], "first vote of the epoch");
});

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
  assert.deepEqual(proportional([30, 10, 0]), [0.75, 0.25, 0]);
  assert.deepEqual(proportional([9_995, 5]), [1, 0], "under 0.1% is dropped");
  assert.equal(proportional([0]), null);
  const x = proportional(Array.from({ length: 50 }, (_, i) => i + 1))!;
  assert.equal(x.filter((xi) => xi > 0).length, 40);
  assert.ok(Math.abs(x[49]! / x[10]! - 50 / 11) < 1e-9, "the rest keep their proportions");
});

test("a vote is in basis points, without the pools that get none", () => {
  assert.deepEqual(toVote([{ pool: A }, { pool: B }, { pool: C }], [0.75, 0, 0.25]), {
    pools: [A, C],
    weights: [7500n, 2500n],
  });
});

test("a smaller pool limit, as the immutable conduit's 20, applies to every allocation", () => {
  assert.equal(waterFill(many(50), 1_000_000n, 20)!.filter((xi) => xi > 0).length, 20);
  assert.equal(
    proportional(
      Array.from({ length: 50 }, (_, i) => i + 1),
      20,
    )!.filter((xi) => xi > 0).length,
    20,
  );
  const { vote } = select(many(50), 1_000_000n, 20);
  assert.equal(vote!.pools.length, 20);
});

test("a conduit's score values the same allocation at its own prices", () => {
  const candidates = [candidate(A, 100, 1000n), candidate(B, 0, 1000n)];
  assert.ok(Math.abs(score(candidates, [0, 100], [0.5, 0.5], 1000n) - (100 * 500) / 1500) < 1e-9);
  assert.equal(score(candidates, [0, 100], [1, 0], 1000n), 0);
});

test("above a bar, the allocation gives up as little at our prices as the conduit's check needs", () => {
  // Our prices value only A and the conduit's check values only B. Scoring 10 needs a share f on B with
  // 100·f/(1 + f) ≥ 10, so f ≥ 1/9.
  const candidates = [candidate(A, 100, 1000n), candidate(B, 0, 1000n)];
  const x = waterFillAbove(candidates, 1000n, [0, 100], 10)!;
  assert.ok(score(candidates, [0, 100], x, 1000n) >= 10);
  assert.ok(Math.abs(x[1]! - 1 / 9) < 0.002, `put ${x[1]} on B`);
  assert.deepEqual(waterFillAbove(candidates, 1000n, [0, 100], 0), [1, 0], "no bar: our own best");
  assert.equal(waterFillAbove(candidates, 1000n, [0, 100], 60), null, "not even all on B scores 60");
  assert.equal(waterFillAbove(candidates, 1000n, [0, 0], 1), null, "the conduit values nothing");
  const ours = waterFill(candidates, 1000n);
  assert.deepEqual(waterFillAbove(candidates, 1000n, [0, 100], 10, undefined, ours), x, "our water-filling, given");
});

test("the gain of an allocation is over the vote in force, at our prices", () => {
  const candidates = [candidate(A, 1000, 100n, 25n), candidate(B, 1000, 100n, 25n)];
  assert.ok(Math.abs(gain(candidates, [0.5, 0.5], 50n)) < 1e-9);
  assert.ok(gain(candidates, [1, 0], 50n) < 0);
});

test("a vote's shares are its fractions rounded to basis points, as the Voter splits its power", () => {
  assert.deepEqual(asVoted([0.33333, 0.66667]), [0.3333, 0.6667]);
  assert.deepEqual(asVoted([0.00004, 0.99996]), [0, 1], "under half a basis point is no vote");
  assert.deepEqual(asVoted([0, 0]), [0, 0]);
});

test("a summary gives the shares in percent, the expected reward and the vote in force", () => {
  const candidates = [candidate(A, 100, 100n, 7n), candidate(B, 0, 100n)];
  assert.deepEqual(summarize(candidates, [1, 0], 100n), {
    plan: [{ pool: A, share: 100 }],
    expectedUsd: 50,
    currentVote: [{ pool: A, votes: 7n }],
    power: 100n,
  });
  assert.deepEqual(summarize(candidates, null, 100n).plan, []);
});

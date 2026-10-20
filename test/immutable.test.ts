import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { decideV2, pricedPools, v2Candidates, votesOf, type Onchain } from "../src/immutable.ts";
import type { State } from "../src/read.ts";
import { score } from "../src/select.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [A, B, C, USDC, HYDX] = [addr(10), addr(11), addr(12), addr(13), addr(14)] as const;
const E = 10n ** 18n; // votes have 18 decimals

/** Pools A and B with 1,000 votes from others each; the Klima conduit's are on A, the immutable conduit's on B. */
function state({ v2Power = 1000n * E, v2OnB = 0n } = {}): State {
  const reward = (token: Address) => [{ token, amount: 1n, decimals: 6 }];
  return {
    epoch: {
      start: 0n,
      flip: 604_800n,
      power: 5000n * E,
      lastVoted: 0n,
      votedThisEpoch: true,
      v2: { power: v2Power, lastVoted: 0n, votedThisEpoch: v2OnB > 0n },
    },
    pools: [
      { pool: A, rewards: reward(HYDX), otherVotes: 1000n * E, ownVotes: 500n * E, v2Votes: 0n },
      { pool: B, rewards: reward(USDC), otherVotes: 1000n * E + v2OnB, ownVotes: 0n, v2Votes: v2OnB },
    ],
  };
}

const onchain = (current: number, a: number, b: number): Onchain => ({
  current,
  values: new Map([
    [A.toLowerCase() as Address, a],
    [B.toLowerCase() as Address, b],
  ]),
});

test("the immutable conduit counts the Klima conduit's votes as others', and not its own", () => {
  const candidates = v2Candidates(state({ v2OnB: 200n * E }), [100, 100]);
  assert.deepEqual(
    candidates.map((c) => [c.otherVotes / E, c.ownVotes / E]),
    [
      [1500n, 0n],
      [1000n, 200n],
    ],
  );
});

test("a vote's votes on each pool split the power by weight", () => {
  assert.deepEqual(votesOf([{ pool: A }, { pool: B }, { pool: C }], { pools: [C, A], weights: [3n, 1n] }, 1000n), [
    250n,
    0n,
    750n,
  ]);
});

test("the pools the conduit can value are those paid in a token it prices", () => {
  assert.deepEqual(pricedPools(state().pools, [USDC]), [B]);
});

test("our best vote is sent when it clears the conduit's check", () => {
  const decision = decideV2(state(), [100, 100], onchain(0, 100, 100));
  assert.ok(decision.vote);
  assert.deepEqual(decision.vote.pools, [A, B]);
  const planned = decision.votes.reduce((a, b) => a + b, 0n);
  assert.ok(planned <= 1000n * E && planned > 1000n * E - 10n, "the Klima conduit plans with all of it");
});

test("when ours does not clear the check, the vote that does at the least cost at our prices", () => {
  // We value A only, the conduit values B only, and the vote in force scores 10.
  const decision = decideV2(state(), [100, 0], onchain(10, 0, 100));
  assert.ok(decision.vote);
  const x = decision.votes.map((v) => Number(v) / Number(1000n * E));
  const scored = score(v2Candidates(state(), [100, 0]), [0, 100], x, 1000n * E);
  assert.ok(scored >= 11.1 - 0.01, `MIN_GAIN plus the margin, rounded to basis points: ${scored}`);
  assert.ok(x[0]! > 0.7, `most stays on A: ${x}`);
  const hopeless = decideV2(state(), [100, 0], onchain(1000, 0, 100));
  assert.equal(hopeless.vote, null);
  assert.match(hopeless.note, /no vote clears v2's check/);
});

test("without the conduit's values, our best vote is left to the simulation", () => {
  assert.ok(decideV2(state(), [100, 0], undefined).vote);
});

test("the last blocks re-vote only for a gain over a dollar; a day before, the vote is always cast", () => {
  const voted = state({ v2OnB: 1000n * E });
  const keep = decideV2(voted, [0, 100], onchain(0, 0, 100));
  assert.equal(keep.vote, null, "all on B already");
  assert.deepEqual(keep.votes, [0n, 1000n * E], "the Klima conduit plans with the vote in force");
  const dayBefore = decideV2(voted, [0, 100], onchain(0, 0, 100), true);
  assert.deepEqual(dayBefore.vote, { pools: [B], weights: [10_000n] });
});

test("without voting power, the immutable conduit does not vote", () => {
  const decision = decideV2(state({ v2Power: 0n }), [100, 100], onchain(0, 100, 100));
  assert.equal(decision.vote, null);
  assert.match(decision.note, /no voting power/);
});

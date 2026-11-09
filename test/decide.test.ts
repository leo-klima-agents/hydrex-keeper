import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { immutableAbi } from "../src/abi.ts";
import type { Client, Conduit } from "../src/chain.ts";
import { pricedPools, readValues, type Onchain } from "../src/onchain.ts";
import { candidatesFor, decide, proportionalVote, votesOf } from "../src/decide.ts";
import type { State } from "../src/read.ts";
import { score } from "../src/select.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [A, B, C, USDC, HYDX] = [addr(10), addr(11), addr(12), addr(13), addr(14)] as const;
const E = 10n ** 18n;

/** The Klima conduit has 500 votes on A, and the immutable conduit `immutableOnB` on B, among 1000 others on each. */
function state({ immutablePower = 1000n * E, immutableOnB = 0n } = {}): State {
  const reward = (token: Address) => [{ token, amount: 1n, decimals: 6 }];
  return {
    epoch: {
      start: 0n,
      flip: 604_800n,
      votes: {
        klima: { power: 5000n * E, lastVoted: 0n, votedThisEpoch: true },
        immutable: { power: immutablePower, lastVoted: 0n, votedThisEpoch: immutableOnB > 0n },
      },
    },
    pools: [
      { pool: A, rewards: reward(HYDX), weight: 1500n * E, votes: { klima: 500n * E, immutable: 0n } },
      {
        pool: B,
        rewards: reward(USDC),
        weight: 1000n * E + immutableOnB,
        votes: { klima: 0n, immutable: immutableOnB },
      },
    ],
    scores: {},
  };
}

const onchain = (current: number, a: number, b: number): Onchain => ({
  current,
  values: new Map([
    [A.toLowerCase() as Address, a],
    [B.toLowerCase() as Address, b],
  ]),
});

test("each conduit counts the other's votes as others', and not its own", () => {
  const voted = state({ immutableOnB: 200n * E });
  const votes = (name: "klima" | "immutable", planned = {}) =>
    candidatesFor(voted, [100, 100], name, planned).map((c) => [c.otherVotes / E, c.ownVotes / E]);
  assert.deepEqual(votes("immutable"), [
    [1500n, 0n],
    [1000n, 200n],
  ]);
  assert.deepEqual(votes("klima"), [
    [1000n, 500n],
    [1200n, 0n],
  ]);
  const planned = { immutable: new Map([[B.toLowerCase() as Address, 300n * E]]) };
  assert.deepEqual(
    votes("klima", planned),
    [
      [1000n, 500n],
      [1300n, 0n],
    ],
    "with the other's planned votes in place of its votes in force",
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
  const decision = decide("immutable", state(), [100, 100], { onchain: onchain(0, 100, 100) });
  assert.ok(decision.vote);
  assert.deepEqual(decision.vote.pools, [A, B]);
  const planned = decision.votes.reduce((a, b) => a + b, 0n);
  assert.ok(planned <= 1000n * E && planned > 1000n * E - 10n, "the other conduit plans with all of it");
});

test("when ours does not clear the check, the vote that does at the least cost at our prices", () => {
  // Our prices value only A, the conduit's check values only B, and the vote in force scores 10.
  const decision = decide("immutable", state(), [100, 0], { onchain: onchain(10, 0, 100) });
  assert.ok(decision.vote);
  const x = decision.votes.map((v) => Number(v) / Number(1000n * E));
  const scored = score(candidatesFor(state(), [100, 0], "immutable"), [0, 100], x, 1000n * E);
  assert.ok(scored >= 11.1 - 0.01, `MIN_GAIN plus the margin, rounded to basis points: ${scored}`);
  assert.ok(x[0]! > 0.7, `most stays on A: ${x}`);
  const hopeless = decide("immutable", state(), [100, 0], { onchain: onchain(1000, 0, 100) });
  assert.equal(hopeless.vote, null);
  assert.match(hopeless.note, /no vote clears the conduit's check/);
});

test("without the conduit's values, our best vote is left to the simulation", () => {
  assert.ok(decide("immutable", state(), [100, 0]).vote);
});

test("the last blocks re-vote only for a gain over a dollar; a day before, the vote is always cast", () => {
  const voted = state({ immutableOnB: 1000n * E });
  const keep = decide("immutable", voted, [0, 100], { onchain: onchain(0, 0, 100) });
  assert.equal(keep.vote, null, "all on B already");
  assert.deepEqual(keep.votes, [0n, 1000n * E], "the other conduit plans with the vote in force");
  const dayBefore = decide("immutable", voted, [0, 100], { onchain: onchain(0, 0, 100), proportionally: true });
  assert.deepEqual(dayBefore.vote, { pools: [B], weights: [10_000n] });
});

test("a day before, a vote that clears the conduit's check only by losing at our prices keeps the vote in force", () => {
  // The vote in force is all on B and worth $50 at our prices. The conduit's check values only A, so clearing it
  // takes 40% on A.
  const checked = { onchain: onchain(20, 100, 0) };
  const voted = state({ immutableOnB: 1000n * E });
  const decision = decide("immutable", voted, [10, 100], { ...checked, proportionally: true });
  assert.equal(decision.vote, null);
  assert.match(decision.note, /no vote that clears the conduit's check gains enough/);
  const lastBlocks = decide("immutable", voted, [10, 100], checked);
  assert.equal(lastBlocks.vote, null, "nor in the last blocks");
  const fresh = decide("immutable", state(), [10, 100], { ...checked, proportionally: true });
  assert.ok(fresh.vote, "it gains on no vote in force");
});

test("without voting power, a conduit does not vote", () => {
  const decision = decide("immutable", state({ immutablePower: 0n }), [100, 100], { onchain: onchain(0, 100, 100) });
  assert.equal(decision.vote, null);
  assert.match(decision.note, /no voting power/);
});

test("each conduit's vote keeps at most its number of pools", () => {
  const pools = Array.from({ length: 60 }, (_, i) => ({
    pool: addr(100 + i),
    rewards: [],
    weight: 1_000n * E,
    votes: { klima: 0n, immutable: 0n },
  }));
  const many: State = { ...state(), pools };
  const usd = pools.map(() => 100);
  assert.equal(decide("klima", many, usd).vote!.pools.length, 40);
  assert.equal(decide("immutable", many, usd).vote!.pools.length, 20);
  assert.equal(decide("klima", many, usd, { proportionally: true }).vote!.pools.length, 40);
  assert.equal(decide("immutable", many, usd, { proportionally: true }).vote!.pools.length, 20);
});

test("the vote clears the conduit's check as the Voter splits it, rounded to basis points", () => {
  // In each random case, the vote in force scores a little more than our best vote, so the check decides the vote.
  let seed = 7;
  const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  const power = 176_730n * E;
  let checked = 0;
  for (let c = 0; c < 30; c++) {
    const pools = Array.from({ length: 60 }, (_, i) => ({
      pool: addr(100 + i),
      rewards: [],
      weight: BigInt(Math.floor(1_000 + rand() * 2_000_000)) * E,
      votes: { klima: 0n, immutable: 0n },
    }));
    const { epoch } = state();
    const s: State = {
      ...state(),
      pools,
      epoch: { ...epoch, votes: { ...epoch.votes, immutable: { power, lastVoted: 0n, votedThisEpoch: false } } },
    };
    const usd = pools.map(() => rand() * 5_000);
    const values = pools.map(() => (rand() < 0.3 ? 0 : rand() * 30_000));
    const candidates = candidatesFor(s, usd, "immutable");
    const share = (votes: bigint[]) => votes.map((v) => Number(v) / Number(power));
    const ours = decide("immutable", s, usd);
    const current = score(candidates, values, share(ours.votes), power) + rand() * 50;
    const byPool = new Map(pools.map((p, i) => [p.pool.toLowerCase() as Address, values[i]!]));
    const decision = decide("immutable", s, usd, { onchain: { current, values: byPool } });
    if (!decision.vote) continue;
    checked++;
    const sent = votesOf(candidates, decision.vote, power);
    assert.ok(score(candidates, values, share(sent), power) >= current + 1.1 - 1e-6, `case ${c}`);
  }
  assert.ok(checked >= 25, `${checked} cases voted`);
});

test("the conduit's values of pools are read a few heavy calls at a time", async () => {
  let inFlight = 0;
  let most = 0;
  const client = {
    multicall: async ({ contracts }: { contracts: { args: readonly unknown[] }[] }) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return contracts.map(({ args }) => BigInt(args[0] as Address) * E);
    },
  } as unknown as Client;
  const pools = Array.from({ length: 167 }, (_, i) => addr(100 + i));
  const conduit = { address: B, abi: immutableAbi } as unknown as Conduit;
  const values = await readValues(conduit, client, pools);
  assert.equal(values.size, 167);
  assert.equal(values.get(addr(266)), 266, "in USD");
  assert.equal(most, 3, "7 calls of 25 pools, 3 at once");
});

test("a day before, a conduit without a check votes in proportion to rewards, from the rewards alone", () => {
  const pools = [A, B, C].map((pool) => ({ pool }));
  const { vote, note, summary } = proportionalVote("klima", pools, [300, 100, 0]);
  assert.deepEqual(vote, { pools: [A, B], weights: [7_500n, 2_500n] });
  assert.equal(note, "");
  assert.deepEqual(summary, {
    plan: [
      { pool: A, share: 75 },
      { pool: B, share: 25 },
    ],
  });
  assert.equal(proportionalVote("klima", pools, [0, 0, 0]).vote, null, "no pool pays anything");
});

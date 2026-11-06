import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import type { Chain, Client } from "../src/chain.ts";
import {
  decideImmutable,
  immutableCandidates,
  pricedPools,
  readValues,
  votesOf,
  type Onchain,
} from "../src/immutable.ts";
import type { State } from "../src/read.ts";
import { score } from "../src/select.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [A, B, C, USDC, HYDX] = [addr(10), addr(11), addr(12), addr(13), addr(14)] as const;
const E = 10n ** 18n;

function state({ immutablePower = 1000n * E, immutableOnB = 0n } = {}): State {
  const reward = (token: Address) => [{ token, amount: 1n, decimals: 6 }];
  return {
    epoch: {
      start: 0n,
      flip: 604_800n,
      power: 5000n * E,
      lastVoted: 0n,
      votedThisEpoch: true,
      immutable: { power: immutablePower, lastVoted: 0n, votedThisEpoch: immutableOnB > 0n },
    },
    pools: [
      { pool: A, rewards: reward(HYDX), otherVotes: 1000n * E, ownVotes: 500n * E, immutableVotes: 0n },
      {
        pool: B,
        rewards: reward(USDC),
        otherVotes: 1000n * E + immutableOnB,
        ownVotes: 0n,
        immutableVotes: immutableOnB,
      },
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
  const candidates = immutableCandidates(state({ immutableOnB: 200n * E }), [100, 100]);
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
  const decision = decideImmutable(state(), [100, 100], onchain(0, 100, 100));
  assert.ok(decision.vote);
  assert.deepEqual(decision.vote.pools, [A, B]);
  const planned = decision.votes.reduce((a, b) => a + b, 0n);
  assert.ok(planned <= 1000n * E && planned > 1000n * E - 10n, "the Klima conduit plans with all of it");
});

test("when ours does not clear the check, the vote that does at the least cost at our prices", () => {
  // Our prices value only A, the conduit's check values only B, and the vote in force scores 10.
  const decision = decideImmutable(state(), [100, 0], onchain(10, 0, 100));
  assert.ok(decision.vote);
  const x = decision.votes.map((v) => Number(v) / Number(1000n * E));
  const scored = score(immutableCandidates(state(), [100, 0]), [0, 100], x, 1000n * E);
  assert.ok(scored >= 11.1 - 0.01, `MIN_GAIN plus the margin, rounded to basis points: ${scored}`);
  assert.ok(x[0]! > 0.7, `most stays on A: ${x}`);
  const hopeless = decideImmutable(state(), [100, 0], onchain(1000, 0, 100));
  assert.equal(hopeless.vote, null);
  assert.match(hopeless.note, /no vote clears the immutable conduit's check/);
});

test("without the conduit's values, our best vote is left to the simulation", () => {
  assert.ok(decideImmutable(state(), [100, 0], undefined).vote);
});

test("the last blocks re-vote only for a gain over a dollar; a day before, the vote is always cast", () => {
  const voted = state({ immutableOnB: 1000n * E });
  const keep = decideImmutable(voted, [0, 100], onchain(0, 0, 100));
  assert.equal(keep.vote, null, "all on B already");
  assert.deepEqual(keep.votes, [0n, 1000n * E], "the Klima conduit plans with the vote in force");
  const dayBefore = decideImmutable(voted, [0, 100], onchain(0, 0, 100), true);
  assert.deepEqual(dayBefore.vote, { pools: [B], weights: [10_000n] });
});

test("a day before, a vote that clears the conduit's check only by losing at our prices keeps the vote in force", () => {
  // The vote in force is all on B and worth $50 at our prices. The conduit's check values only A, so clearing it
  // takes 40% on A.
  const decision = decideImmutable(state({ immutableOnB: 1000n * E }), [10, 100], onchain(20, 100, 0), true);
  assert.equal(decision.vote, null);
  assert.match(decision.note, /no vote that clears the immutable conduit's check gains enough/);
  const lastBlocks = decideImmutable(state({ immutableOnB: 1000n * E }), [10, 100], onchain(20, 100, 0));
  assert.equal(lastBlocks.vote, null, "nor in the last blocks");
  assert.ok(decideImmutable(state(), [10, 100], onchain(20, 100, 0), true).vote, "it gains on no vote in force");
});

test("without voting power, the immutable conduit does not vote", () => {
  const decision = decideImmutable(state({ immutablePower: 0n }), [100, 100], onchain(0, 100, 100));
  assert.equal(decision.vote, null);
  assert.match(decision.note, /no voting power/);
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
      otherVotes: BigInt(Math.floor(1_000 + rand() * 2_000_000)) * E,
      ownVotes: 0n,
      immutableVotes: 0n,
    }));
    const s: State = {
      ...state(),
      pools,
      epoch: { ...state().epoch, immutable: { power, lastVoted: 0n, votedThisEpoch: false } },
    };
    const usd = pools.map(() => rand() * 5_000);
    const values = pools.map(() => (rand() < 0.3 ? 0 : rand() * 30_000));
    const candidates = immutableCandidates(s, usd);
    const share = (votes: bigint[]) => votes.map((v) => Number(v) / Number(power));
    const ours = decideImmutable(s, usd, undefined);
    const current = score(candidates, values, share(ours.votes), power) + rand() * 50;
    const byPool = new Map(pools.map((p, i) => [p.pool.toLowerCase() as Address, values[i]!]));
    const decision = decideImmutable(s, usd, { current, values: byPool });
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
  const chain = { immutable: { conduit: B, proposer: C, priced: [] } } as unknown as Chain;
  const values = await readValues(chain, client, pools);
  assert.equal(values.size, 167);
  assert.equal(values.get(addr(266)), 266, "in USD");
  assert.equal(most, 3, "7 calls of 25 pools, 3 at once");
});

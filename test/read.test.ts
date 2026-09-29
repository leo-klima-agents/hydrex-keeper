import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroAddress, type Address } from "viem";
import { readMany, WEEK, type Chain, type Client } from "../src/chain.ts";
import { LayoutChanged, readEpoch, readLayout, readPass } from "../src/read.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [VOTER, CONDUIT, VE] = [addr(1), addr(2), addr(97)] as const;
const [POOL_A, POOL_B, POOL_C, GAUGE_A, GAUGE_B] = [addr(3), addr(4), addr(5), addr(6), addr(7)] as const;
const [EXT_A, INT_A, EXT_B, INT_B] = [addr(8), addr(9), addr(10), addr(11)] as const;
const [TOK_1, TOK_2, TOK_3] = [addr(12), addr(13), addr(14)] as const;

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

let multicalls = 0;

/** A client whose multicall answers from a table and counts round trips; unknown calls fail. */
function fakeChain(answer: (call: Call) => unknown): Chain {
  const client = {
    multicall: async ({ contracts, allowFailure }: { contracts: Call[]; allowFailure: boolean }) => {
      multicalls++;
      return contracts.map((call) => {
        try {
          const result = answer(call);
          return allowFailure ? { status: "success", result } : result;
        } catch (error) {
          if (allowFailure) return { status: "failure", error };
          throw error;
        }
      });
    },
  } as unknown as Client;
  const broadcast = async () => assert.fail("reads never send");
  return { client, broadcast, module: addr(99), conduit: CONDUIT, keeper: addr(98), voter: VOTER, ve: VE };
}

const gauges: Record<string, Address> = { [POOL_A]: GAUGE_A, [POOL_B]: GAUGE_B, [POOL_C]: zeroAddress };
const externalBribes: Record<string, Address> = { [GAUGE_A]: EXT_A, [GAUGE_B]: EXT_B };
const internalBribes: Record<string, Address> = { [GAUGE_A]: INT_A, [GAUGE_B]: INT_B };
const weights: Record<string, bigint> = { [POOL_A]: 1000n, [POOL_B]: 500n };
const ownVotes: Record<string, bigint> = { [POOL_A]: 100n, [POOL_B]: 0n };
const rewardTokens: Record<string, Address[]> = {
  [EXT_A]: [TOK_1, TOK_2],
  [INT_A]: [],
  [EXT_B]: [TOK_3],
  [INT_B]: [TOK_1],
};
const amounts: Record<string, bigint> = {
  [EXT_A + TOK_1]: 7n,
  [EXT_A + TOK_2]: 0n,
  [EXT_B + TOK_3]: 5n,
  [INT_B + TOK_1]: 3n,
};
const voterState = { start: 1000n, lastVoted: 1000n };
let calendarAt: unknown;

function table({ address, functionName, args = [] }: Call): unknown {
  const arg = args[0] as string;
  if (address === VE && functionName === "getPastVotes") {
    calendarAt = args[1];
    return 10n;
  }
  if (address === VOTER) {
    switch (functionName) {
      case "_epochTimestamp":
        return voterState.start;
      case "lastVoted":
        return voterState.lastVoted;
      case "gauges":
        return gauges[arg];
      case "external_bribes":
        return externalBribes[arg];
      case "internal_bribes":
        return internalBribes[arg];
      case "isAlive":
        return arg !== GAUGE_B;
      case "weights":
        return weights[arg];
      case "votes":
        return ownVotes[args[1] as string];
    }
  }
  if (functionName === "rewardsListLength") return BigInt(rewardTokens[address]!.length);
  if (functionName === "rewardTokens") return rewardTokens[address]![Number(args[0])];
  if (functionName === "rewardData") {
    assert.equal(args[1], calendarAt, "reads the calendar epoch");
    return [1000n, amounts[address + arg], 0n];
  }
  if (functionName === "decimals") {
    if (address === TOK_3) throw new Error("no decimals()");
    return address === TOK_1 ? 6 : 18;
  }
  throw new Error(`unexpected call ${functionName} on ${address}`);
}

const epoch = { start: 1000n, flip: 1000n + WEEK, power: 10n, votedThisEpoch: true };

test("readLayout drops pools without a gauge and defaults missing decimals", async () => {
  const s = await readLayout(fakeChain(table), [POOL_A, POOL_B, POOL_C]);
  assert.deepEqual(s.pools, [POOL_A, POOL_B]);
  assert.deepEqual(s.bribes, [EXT_A, INT_A, EXT_B, INT_B]);
  assert.deepEqual(s.lengths, [2n, 0n, 1n, 1n]);
  assert.deepEqual(s.slots, [
    { pool: 0, bribe: EXT_A, token: TOK_1, decimals: 6 },
    { pool: 0, bribe: EXT_A, token: TOK_2, decimals: 18 },
    { pool: 1, bribe: EXT_B, token: TOK_3, decimals: 18 },
    { pool: 1, bribe: INT_B, token: TOK_1, decimals: 6 },
  ]);
});

test("readPass reads the epoch, and maps rewards, liveness and votes per pool", async () => {
  const chain = fakeChain(table);
  const s = await readLayout(chain, [POOL_A, POOL_B]);
  assert.deepEqual(await readPass(chain, s), {
    epoch,
    rewards: [
      {
        pool: POOL_A,
        alive: true,
        otherVotes: 900n,
        ownVotes: 100n,
        rewards: [{ token: TOK_1, amount: 7n, decimals: 6 }],
      },
      {
        pool: POOL_B,
        alive: false,
        otherVotes: 500n,
        ownVotes: 0n,
        rewards: [
          { token: TOK_3, amount: 5n, decimals: 18 },
          { token: TOK_1, amount: 3n, decimals: 6 },
        ],
      },
    ],
  });
  voterState.lastVoted = 999n;
  try {
    const { epoch: stale, rewards } = await readPass(chain, s);
    assert.equal(stale.votedThisEpoch, false);
    assert.deepEqual(
      [rewards[0]!.otherVotes, rewards[0]!.ownVotes],
      [1000n, 0n],
      "last epoch's own votes are neither subtracted nor counted",
    );
  } finally {
    voterState.lastVoted = 1000n;
  }
});

test("readPass is one multicall however many calls it makes; no calls make no request", async () => {
  const chain = fakeChain(table);
  const s = await readLayout(chain, [POOL_A]);
  multicalls = 0;
  const { rewards } = await readPass(chain, { ...s, slots: Array.from({ length: 200 }, () => s.slots[0]!) });
  assert.equal(rewards[0]!.rewards.length, 200);
  assert.deepEqual(await readMany(chain.client, []), []);
  assert.equal(multicalls, 1);
});

test("readPass reports a grown reward token list", async () => {
  const chain = fakeChain(table);
  const s = await readLayout(chain, [POOL_A]);
  rewardTokens[INT_A] = [TOK_2];
  try {
    await assert.rejects(readPass(chain, s), LayoutChanged);
  } finally {
    rewardTokens[INT_A] = [];
  }
});

test("readEpoch reads the epoch and the power at the calendar epoch in one round trip", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_790_812_805_000 });
  const chain = fakeChain(table);
  multicalls = 0;
  assert.deepEqual(await readEpoch(chain), epoch);
  assert.equal(multicalls, 1);
  assert.equal(calendarAt, 1_790_812_800n);
});

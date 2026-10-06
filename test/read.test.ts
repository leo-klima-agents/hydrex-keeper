import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { now, readMany, WEEK, type Chain, type Client } from "../src/chain.ts";
import { readEpoch, readRewards, readVotes } from "../src/read.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [VOTER, CONDUIT, VE] = [addr(1), addr(2), addr(97)] as const;
const [POOL_A, POOL_B, POOL_C, POOL_D] = [addr(3), addr(4), addr(5), addr(15)] as const;
const [GAUGE_A, GAUGE_B, GAUGE_C, GAUGE_D] = [addr(6), addr(7), addr(16), addr(17)] as const;
const [EXT_A, INT_A, EXT_B, INT_B] = [addr(8), addr(9), addr(10), addr(11)] as const;
const [EXT_C, INT_C, EXT_D, INT_D] = [addr(18), addr(19), addr(20), addr(21)] as const;
const [TOK_1, TOK_2, TOK_3] = [addr(12), addr(13), addr(14)] as const;

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

let multicalls = 0;
const blockTags: unknown[] = [];

/** A client whose multicall answers from a table and counts round trips; unknown calls fail. */
function fakeChain(answer: (call: Call) => unknown): Chain {
  const client = {
    multicall: async ({ contracts, blockTag }: { contracts: Call[]; blockTag?: string }) => {
      multicalls++;
      blockTags.push(blockTag);
      return contracts.map(answer);
    },
  } as unknown as Client;
  const broadcast = async () => assert.fail("reads never send");
  return { client, broadcast, module: addr(99), conduit: CONDUIT, keeper: addr(98), voter: VOTER, ve: VE };
}

const pools = [POOL_A, POOL_B, POOL_C, POOL_D];
const gauges: Record<string, Address> = { [POOL_A]: GAUGE_A, [POOL_B]: GAUGE_B, [POOL_C]: GAUGE_C, [POOL_D]: GAUGE_D };
const externalBribes: Record<string, Address> = {
  [GAUGE_A]: EXT_A,
  [GAUGE_B]: EXT_B,
  [GAUGE_C]: EXT_C,
  [GAUGE_D]: EXT_D,
};
const internalBribes: Record<string, Address> = {
  [GAUGE_A]: INT_A,
  [GAUGE_B]: INT_B,
  [GAUGE_C]: INT_C,
  [GAUGE_D]: INT_D,
};
const weights: Record<string, bigint> = { [POOL_A]: 1000n, [POOL_B]: 500n };
const ownVotes: Record<string, bigint> = { [POOL_A]: 100n, [POOL_B]: 0n };
const rewardTokens: Record<string, Address[]> = {
  [EXT_A]: [TOK_1, TOK_2],
  [INT_A]: [],
  [EXT_B]: [TOK_3],
  [INT_B]: [TOK_1],
  [EXT_D]: [TOK_3],
  [INT_D]: [],
};
const amounts: Record<string, bigint> = { [EXT_A + TOK_1]: 7n, [EXT_A + TOK_2]: 0n, [INT_B + TOK_1]: 3n };
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
      case "length":
        return BigInt(pools.length);
      case "pools":
        return pools[Number(arg)];
      case "gauges":
        return gauges[arg];
      case "isAlive":
        return arg !== GAUGE_C;
      case "external_bribes":
        return externalBribes[arg];
      case "internal_bribes":
        return internalBribes[arg];
      case "weights":
        return weights[arg];
      case "votes":
        return ownVotes[args[1] as string];
    }
  }
  if (functionName === "rewardsListLength") return BigInt(rewardTokens[address]!.length);
  if (functionName === "rewardTokens") return rewardTokens[address]![Number(args[0])];
  if (functionName === "rewardData" && arg !== TOK_3) {
    assert.equal(args[1], (now() / WEEK) * WEEK, "reads the calendar epoch");
    return [1000n, amounts[address + arg], 0n];
  }
  if (functionName === "decimals") return address === TOK_1 ? 6 : 18;
  throw new Error(`unexpected call ${functionName} on ${address}`);
}

const epoch = { start: 1000n, flip: 1000n + WEEK, power: 10n, lastVoted: 1000n, votedThisEpoch: true };

test("readRewards keeps the pools with live gauges and rewards in whitelisted tokens, and those rewards alone", async () => {
  const rewards = await readRewards(fakeChain(table), [TOK_1, TOK_2]);
  assert.deepEqual(rewards, [
    { pool: POOL_A, rewards: [{ token: TOK_1, amount: 7n, decimals: 6 }] },
    { pool: POOL_B, rewards: [{ token: TOK_1, amount: 3n, decimals: 6 }] },
  ]);
});

test("readVotes reads the epoch and the votes on each pool, in one multicall for up to 498 pools", async () => {
  const chain = fakeChain(table);
  const rewards = await readRewards(chain, [TOK_1]);
  multicalls = 0;
  assert.deepEqual(await readVotes(chain, rewards), {
    epoch,
    pools: [
      { ...rewards[0]!, otherVotes: 900n, ownVotes: 100n },
      { ...rewards[1]!, otherVotes: 500n, ownVotes: 0n },
    ],
  });
  await readVotes(chain, Array<(typeof rewards)[number]>(498).fill(rewards[0]!));
  assert.equal(multicalls, 2);
  assert.deepEqual(await readMany(chain.client, []), []);
  assert.equal(multicalls, 2, "no calls make no request");
  voterState.lastVoted = 999n;
  try {
    const { epoch: stale, pools } = await readVotes(chain, rewards);
    assert.equal(stale.votedThisEpoch, false);
    assert.deepEqual(
      [pools[0]!.otherVotes, pools[0]!.ownVotes],
      [1000n, 0n],
      "last epoch's own votes are neither subtracted nor counted",
    );
  } finally {
    voterState.lastVoted = 1000n;
  }
});

test("asked for the block being built, readVotes reads it", async () => {
  const chain = fakeChain(table);
  const rewards = await readRewards(chain, [TOK_1]);
  blockTags.length = 0;
  await readVotes(chain, rewards, "pending");
  assert.deepEqual(blockTags, ["pending"]);
});

test("readEpoch reads the epoch and the power at the calendar epoch in one round trip", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_790_812_805_000 });
  const chain = fakeChain(table);
  multicalls = 0;
  assert.deepEqual(await readEpoch(chain), epoch);
  assert.equal(multicalls, 1);
  assert.equal(calendarAt, 1_790_812_800n);
});

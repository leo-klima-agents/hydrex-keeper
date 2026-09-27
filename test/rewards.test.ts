import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroAddress, type Address } from "viem";
import { CHUNK, type Chain, type Client } from "../src/chain.ts";
import { readEpoch, readState, readStatic, StaticChanged } from "../src/rewards.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [VOTER, CONDUIT, POOL_A, POOL_B, POOL_C, GAUGE_A, GAUGE_B] = [addr(1), addr(2), addr(3), addr(4), addr(5), addr(6), addr(7)] as const;
const [EXT_A, INT_A, EXT_B, INT_B, TOK_1, TOK_2, TOK_3] = [addr(8), addr(9), addr(10), addr(11), addr(12), addr(13), addr(14)] as const;

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

/** A client whose multicall answers from a table and records each batch; unknown calls fail. */
function fakeChain(answer: (call: Call) => unknown, batches: string[][] = []): Chain {
  const client = {
    multicall: async ({ contracts, allowFailure }: { contracts: Call[]; allowFailure: boolean }) => {
      batches.push(contracts.map((c) => c.functionName));
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
  return { client, module: addr(99), conduit: CONDUIT, keeper: addr(98), voter: VOTER, ve: addr(97) };
}

const rewardTokens: Record<string, Address[]> = { [EXT_A]: [TOK_1, TOK_2], [INT_A]: [], [EXT_B]: [TOK_3], [INT_B]: [TOK_1] };
const voterState = { start: 1000n, lastVoted: 1000n };
const table = (call: Call): unknown => {
  const { address, functionName, args = [] } = call;
  if (address === addr(97) && functionName === "getPastVotes") return 10n;
  if (address === VOTER) {
    switch (functionName) {
      case "_epochTimestamp": return voterState.start;
      case "lastVoted": return voterState.lastVoted;
      case "gauges": return ({ [POOL_A]: GAUGE_A, [POOL_B]: GAUGE_B, [POOL_C]: zeroAddress } as Record<string, Address>)[args[0] as string];
      case "external_bribes": return ({ [GAUGE_A]: EXT_A, [GAUGE_B]: EXT_B } as Record<string, Address>)[args[0] as string];
      case "internal_bribes": return ({ [GAUGE_A]: INT_A, [GAUGE_B]: INT_B } as Record<string, Address>)[args[0] as string];
      case "isAlive": return args[0] !== GAUGE_B;
      case "weights": return ({ [POOL_A]: 1000n, [POOL_B]: 500n } as Record<string, bigint>)[args[0] as string];
      case "votes": return ({ [POOL_A]: 100n, [POOL_B]: 0n } as Record<string, bigint>)[args[1] as string];
    }
  }
  if (functionName === "rewardsListLength") return BigInt(rewardTokens[address]!.length);
  if (functionName === "rewardTokens") return rewardTokens[address]![Number(args[0])];
  if (functionName === "rewardData") {
    const amount = ({ [EXT_A + TOK_1]: 7n, [EXT_A + TOK_2]: 0n, [EXT_B + TOK_3]: 5n, [INT_B + TOK_1]: 3n } as Record<string, bigint>)[address + (args[0] as string)];
    assert.equal(args[1], 1000n, "reads the epoch start");
    return [1000n, amount, 0n];
  }
  if (functionName === "decimals") {
    if (address === TOK_3) throw new Error("no decimals()");
    return address === TOK_1 ? 6 : 18;
  }
  throw new Error(`unexpected call ${functionName} on ${address}`);
};

test("readStatic drops pools without a gauge and defaults missing decimals", async () => {
  const s = await readStatic(fakeChain(table), [POOL_A, POOL_B, POOL_C]);
  assert.deepEqual(s.pools, [POOL_A, POOL_B]);
  assert.deepEqual(s.bribes, [EXT_A, INT_A, EXT_B, INT_B]);
  assert.deepEqual(s.lengths, [2n, 0n, 1n, 1n]);
  assert.deepEqual(
    s.slots,
    [
      { pool: 0, bribe: EXT_A, token: TOK_1, decimals: 6 },
      { pool: 0, bribe: EXT_A, token: TOK_2, decimals: 18 },
      { pool: 1, bribe: EXT_B, token: TOK_3, decimals: 18 },
      { pool: 1, bribe: INT_B, token: TOK_1, decimals: 6 },
    ],
  );
});

test("readState reads everything in one multicall: epoch, power, votes, liveness and rewards", async () => {
  const batches: string[][] = [];
  const chain = fakeChain(table);
  const s = await readStatic(chain, [POOL_A, POOL_B]);
  const r = await readState(fakeChain(table, batches), s, 1000n);
  assert.equal(batches.length, 1);
  assert.deepEqual(r, {
    voterStart: 1000n,
    power: 10n,
    currentVote: { pools: [POOL_A], votes: [100n] },
    pools: [
      { pool: POOL_A, alive: true, otherVotes: 900n, rewards: [{ token: TOK_1, amount: 7n, decimals: 6 }] },
      { pool: POOL_B, alive: false, otherVotes: 500n, rewards: [{ token: TOK_3, amount: 5n, decimals: 18 }, { token: TOK_1, amount: 3n, decimals: 6 }] },
    ],
  });
});

test("readState ignores last epoch's vote", async () => {
  const chain = fakeChain(table);
  const s = await readStatic(chain, [POOL_A, POOL_B]);
  voterState.lastVoted = 999n;
  try {
    const r = await readState(chain, s, 1000n);
    assert.deepEqual(r.currentVote, { pools: [], votes: [] });
    assert.equal(r.pools[0]!.otherVotes, 1000n, "last epoch's own votes are not subtracted");
  } finally {
    voterState.lastVoted = 1000n;
  }
});

test("readState reports a grown reward token list", async () => {
  const chain = fakeChain(table);
  const s = await readStatic(chain, [POOL_A]);
  rewardTokens[INT_A] = [TOK_2];
  try {
    await assert.rejects(readState(chain, s, 1000n), StaticChanged);
  } finally {
    rewardTokens[INT_A] = [];
  }
});

test("past one eth_call, only reward amounts spill into the next: votes and the epoch share a block", async () => {
  const batches: string[][] = [];
  const s = await readStatic(fakeChain(table), [POOL_A, POOL_B]);
  const many = { ...s, slots: Array.from({ length: CHUNK }, () => s.slots[0]!) };
  const r = await readState(fakeChain(table, batches), many, 1000n);
  assert.equal(batches.length, 2);
  assert.ok(batches[1]!.every((f) => f === "rewardData"));
  assert.equal(r.pools[0]!.rewards.length, CHUNK);
});

test("readEpoch reads the Voter's epoch", async () => {
  assert.deepEqual(await readEpoch(fakeChain(table)), { start: 1000n, flip: 1000n + 604800n });
});

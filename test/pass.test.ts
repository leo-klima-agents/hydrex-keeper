import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address } from "viem";
import type { Chain, Client } from "../src/chain.ts";
import { perAttempt, valueRewards, votedDayBefore, type Run } from "../src/pass.ts";
import { DAY, HORIZON } from "../src/schedule.ts";
import { conduitsOf, logged } from "./helpers.ts";

test("the day-before reads are shared within a round of attempts, and read again for a retry or after a failure", async () => {
  let reads = 0;
  let fails = true;
  const read = perAttempt(async () => {
    reads++;
    if (fails) throw new Error("timeout");
    return reads;
  });
  await assert.rejects(read(1));
  fails = false;
  assert.equal(await read(1), 2, "a failed read is read again");
  assert.equal(await read(1), 2, "shared by both conduits' first attempts");
  assert.equal(await read(2), 3, "a retry reads again");
});

test("each pool is logged with its rewards, its weight and each conduit's votes", async (t) => {
  const token = getAddress(`0x${"1".repeat(40)}`);
  const pool = getAddress(`0x${"2".repeat(40)}`);
  const run = { tokens: [{ token, name: "TKN" }] } as unknown as Run;
  const priced = new Map([[token.toLowerCase() as Address, 2]]);
  const rewards = [{ token, amount: 3n * 10n ** 18n, decimals: 18 }];
  let usd: number[] = [];
  const pools = [{ pool, rewards, weight: 18n, votes: { klima: 6n, immutable: 7n } }];
  const lines = await logged(t, () => (usd = valueRewards(run, pools, priced, true)));
  assert.deepEqual(usd, [6]);
  assert.deepEqual(lines, [
    {
      severity: "INFO",
      message: "pool",
      pool,
      usd: 6,
      weight: "18",
      votes: { klima: "6", immutable: "7" },
      rewards: [{ token: "TKN", amount: 3, usd: 6 }],
    },
  ]);
});

test("a conduit's vote of a day before is in if the Voter shows one now, and for the immutable conduit, the proposer's", async () => {
  const flip = 1_790_812_800n;
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const [KLIMA, IMMUTABLE, PROPOSER, OTHER] = [addr(1), addr(2), addr(3), addr(4)];
  const lastVoted = new Map<Address, bigint>();
  let proposer = PROPOSER;
  // Blocks 200 ms apart, as on Base.
  const head = { number: 100_000n, ms: (flip - DAY + 7_200n) * 1000n };
  const msOf = (n: bigint) => head.ms - 200n * (head.number - n);
  const client = {
    multicall: async ({ contracts }: { contracts: { args: [Address] }[] }) =>
      contracts.map(({ args }) => lastVoted.get(args[0]) ?? 0n),
    getBlock: async (args?: { blockNumber?: bigint }) => {
      const number = args?.blockNumber ?? head.number;
      const ms = msOf(number);
      return { number, timestamp: ms / 1000n, timestampMs: `0x${ms.toString(16)}` };
    },
    getContractEvents: async ({
      args,
      fromBlock,
      toBlock,
    }: {
      args: { proposer: Address };
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      const voted = lastVoted.get(IMMUTABLE)!;
      assert.deepEqual(
        [msOf(fromBlock - 1n) / 1000n, msOf(fromBlock) / 1000n, msOf(toBlock) / 1000n, msOf(toBlock + 1n) / 1000n],
        [voted - 1n, voted, voted, voted + 1n],
        "every block of the second of the vote in force",
      );
      return args.proposer === proposer ? [{}] : [];
    },
  } as unknown as Client;
  const conduits = conduitsOf(
    {
      klima: { address: KLIMA, from: addr(6), module: addr(7) },
      immutable: { address: IMMUTABLE, from: PROPOSER },
    },
    client,
  );
  const chain = { client, voter: addr(5), conduits } as unknown as Chain;
  const { klima, immutable } = conduits;
  lastVoted.set(KLIMA, flip - DAY - HORIZON - 2n);
  assert.equal(await votedDayBefore(chain, klima, flip), false, "voted more than an hour before");
  lastVoted.set(KLIMA, flip - DAY + 30n);
  assert.equal(await votedDayBefore(chain, klima, flip), true, "only the keeper votes for it");
  lastVoted.set(IMMUTABLE, flip - DAY + 30n);
  assert.equal(await votedDayBefore(chain, immutable, flip), true, "the proposer's vote");
  lastVoted.set(IMMUTABLE, flip - DAY + 300n);
  proposer = OTHER;
  assert.equal(await votedDayBefore(chain, immutable, flip), false, "another's vote since, read when asked");
});

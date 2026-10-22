import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address } from "viem";
import type { Chain, Client } from "../src/chain.ts";
import { perAttempt, valueRewards, votedDayBefore, type Run } from "../src/pass.ts";
import { DAY, HORIZON } from "../src/schedule.ts";
import { klimaSender, v2Sender } from "../src/vote.ts";

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

test("each pool is logged with its rewards and votes, the immutable conduit's included", (t) => {
  const write = t.mock.method(process.stdout, "write", () => true);
  const token = getAddress(`0x${"1".repeat(40)}`);
  const pool = getAddress(`0x${"2".repeat(40)}`);
  const run = { tokens: [{ token, name: "TKN" }] } as unknown as Run;
  const priced = new Map([[token.toLowerCase() as Address, 2]]);
  const rewards = [{ token, amount: 3n * 10n ** 18n, decimals: 18 }];
  const usd = valueRewards(run, [{ pool, rewards, otherVotes: 5n, ownVotes: 6n, v2Votes: 7n }], priced, true);
  assert.deepEqual(usd, [6]);
  const logged = write.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  assert.deepEqual(logged, [
    {
      severity: "INFO",
      message: "pool",
      pool,
      usd: 6,
      otherVotes: "5",
      ownVotes: "6",
      v2Votes: "7",
      rewards: [{ token: "TKN", amount: 3, usd: 6 }],
    },
  ]);
});

test("a conduit's vote of a day before is in if the Voter shows one now, and for the immutable conduit, the proposer's", async () => {
  const flip = 1_790_812_800n;
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const [KLIMA, V2, PROPOSER, OTHER] = [addr(1), addr(2), addr(3), addr(4)];
  const lastVoted = new Map<Address, bigint>();
  let proposer = PROPOSER;
  const head = { number: 100_000n, timestamp: flip - DAY + 7_200n };
  const client = {
    multicall: async ({ contracts }: { contracts: { args: [Address] }[] }) =>
      contracts.map(({ args }) => lastVoted.get(args[0]) ?? 0n),
    getBlock: async (args?: { blockNumber?: bigint }) => {
      const number = args?.blockNumber ?? head.number;
      return { number, timestamp: head.timestamp - 2n * (head.number - number) };
    },
    getContractEvents: async ({ args, fromBlock }: { args: { proposer: Address }; fromBlock: bigint }) => {
      assert.equal(
        head.timestamp - 2n * (head.number - fromBlock),
        lastVoted.get(V2),
        "the block of the vote in force",
      );
      return args.proposer === proposer ? [{}] : [];
    },
  } as unknown as Client;
  const chain = {
    client,
    v2Client: client,
    voter: addr(5),
    keeper: addr(6),
    module: addr(7),
    conduit: KLIMA,
    v2: { conduit: V2, proposer: PROPOSER, priced: [] },
  } as unknown as Chain;
  const [klima, v2] = [klimaSender(chain), v2Sender(chain)];
  lastVoted.set(KLIMA, flip - DAY - HORIZON - 2n);
  assert.equal(await votedDayBefore(chain, klima, flip), false, "voted more than an hour before");
  lastVoted.set(KLIMA, flip - DAY + 30n);
  assert.equal(await votedDayBefore(chain, klima, flip), true, "only the keeper votes for it");
  lastVoted.set(V2, flip - DAY + 30n);
  assert.equal(await votedDayBefore(chain, v2, flip), true, "the proposer's vote");
  lastVoted.set(V2, flip - DAY + 300n);
  proposer = OTHER;
  assert.equal(await votedDayBefore(chain, v2, flip), false, "another's vote since, read when asked");
});

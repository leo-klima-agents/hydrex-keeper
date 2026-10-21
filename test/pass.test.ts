import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address } from "viem";
import { perAttempt, valueRewards, type Run } from "../src/pass.ts";

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

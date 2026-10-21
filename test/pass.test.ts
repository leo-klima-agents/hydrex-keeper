import assert from "node:assert/strict";
import { test } from "node:test";
import { perAttempt } from "../src/pass.ts";

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

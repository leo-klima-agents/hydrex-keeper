import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/chain.ts";
import { runPasses, type Outcome } from "../src/run.ts";
import { VoteSent } from "../src/vote.ts";

const flip = 1_790_812_800n;
const DELAY_MS = 300; // a block shows up this long after its timestamp
const POLL_MS = 200;
const PASS_MS = 400;

type Passed = { block: Block; at: number; until: number };

/**
 * Two-second blocks with odd timestamps, a clock that `sleep` advances, and a `nextBlock` like the real one: the
 * latest block visible, once it is after `after` and minted at or after `mintedAt`, or undefined at `until`.
 */
function world(startMs: number, outcome: (block: Block) => Outcome | Error) {
  let nowMs = startMs;
  const passes: Passed[] = [];
  const latest = (): Block => {
    const seconds = Math.floor((nowMs - DELAY_MS) / 1000);
    const odd = seconds % 2 === 0 ? seconds - 1 : seconds;
    return { number: BigInt((odd - 1) / 2), timestamp: BigInt(odd) };
  };
  const io = {
    now: () => nowMs,
    sleep: async (ms: number) => void (nowMs += ms),
    nextBlock: async (after: bigint, mintedAt: bigint, until: number) => {
      for (;;) {
        const block = latest();
        if (block.number > after && block.timestamp >= mintedAt) return block;
        if (nowMs + POLL_MS >= until) return undefined;
        nowMs += POLL_MS;
      }
    },
    pass: async (block: Block, until: number) => {
      passes.push({ block, at: nowMs, until });
      nowMs += PASS_MS;
      const result = outcome(block);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { io, passes };
}

const ms = (seconds: bigint) => Number(seconds) * 1000;
const timestamps = (passes: Passed[]) => passes.map((p) => p.block.timestamp - flip);

test("a pass runs on the first block minted at or after its time, then one on every block up to the flip", async () => {
  const { io, passes } = world(ms(flip - 1200n), ({ timestamp }) => (timestamp < flip - 2n ? "kept" : "skipped"));
  const failed = await runPasses({ times: [flip - 60n], everyBlock: flip - 10n }, flip, io);
  assert.equal(failed, 0);
  const [first, ...loop] = passes;
  assert.equal(first!.block.timestamp, flip - 59n, "the first odd second at or after the due time");
  assert.equal(first!.until, ms(flip - 10n), "until the pass on every block starts");
  assert.deepEqual(timestamps(loop), [-11n, -9n, -7n, -5n, -3n, -1n], "every block up to the last before the flip");
  assert.ok(
    loop.every((p) => p.until === Math.min(p.at + 5_000, ms(flip - 1n) - 500)),
    "five seconds, or until the last block before the flip is sealed",
  );
  assert.ok(
    loop.every((p, i) => i === 0 || p.block.number === loop[i - 1]!.block.number + 1n),
    "no block skipped",
  );
});

test("a pass without a block before the next one is skipped; a failing one is retried on later blocks", async () => {
  const skipped = world(ms(flip - 61n), () => "voted");
  assert.equal(await runPasses({ times: [flip - 60n, flip - 59n] }, flip, skipped.io), 0);
  assert.deepEqual(timestamps(skipped.passes), [-59n], "the 60 s pass saw no block in its second; the next ran");

  const failing = world(ms(flip - 61n), () => new Error("boom"));
  assert.equal(await runPasses({ times: [flip - 60n] }, flip, failing.io), 1);
  assert.deepEqual(timestamps(failing.passes), [-59n, -55n, -49n], "three attempts, five seconds apart, on new blocks");

  const sent = world(ms(flip - 61n), () => new VoteSent("reverted"));
  assert.equal(await runPasses({ times: [flip - 60n] }, flip, sent.io), 1);
  assert.equal(sent.passes.length, 1, "a sent vote is not retried");
});

test("on every block, a failure is left to the next block, and only every pass failing fails the execution", async () => {
  const once = world(ms(flip - 4n), ({ timestamp }) => (timestamp === flip - 3n ? new Error("boom") : "kept"));
  assert.equal(await runPasses({ times: [], everyBlock: flip - 4n }, flip, once.io), 0);
  assert.deepEqual(timestamps(once.passes), [-5n, -3n, -1n], "a restart inside the window passes what is left");

  const broken = world(ms(flip - 4n), () => new Error("boom"));
  assert.equal(await runPasses({ times: [], everyBlock: flip - 4n }, flip, broken.io), 1);
  assert.equal(broken.passes.length, 3);
});

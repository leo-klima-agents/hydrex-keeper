import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import { runPasses, type Io } from "../src/run.ts";
import { GRACE_MS, lastBlocksStart } from "../src/schedule.ts";
import { VoteSent, type Sent } from "../src/vote.ts";

const flip = 1_790_812_800n;
const interval = 2;
const start = lastBlocksStart(flip, interval);
const ms = (seconds: bigint) => Number(seconds) * 1000;
const sent = (n: number): Sent => ({ hash: `0x${n.toString(16).padStart(64, "0")}`, vote: { pools: [], weights: [] } });

type Step = Sent | undefined | Error;
type Options = { heads?: bigint[]; passMs?: number; confirmError?: Error };

/**
 * A clock that only sleeping and working advance; blocks that appear 100 ms after their timestamp; passes that take
 * `passMs` and answer from `steps` in order; confirmations that take 200 ms.
 */
function world(startMs: number, steps: Step[], { heads = [], passMs = 400, confirmError }: Options = {}) {
  let nowMs = startMs;
  const passes: { at: number; until: number }[] = [];
  const confirms: { hash: Hex; until: number }[] = [];
  const io: Io = {
    now: () => nowMs,
    sleep: async (delay) => void (nowMs += delay),
    pass: async (until) => {
      passes.push({ at: nowMs, until });
      nowMs += passMs;
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return step;
    },
    confirm: async ({ hash }, until) => {
      confirms.push({ hash, until });
      nowMs += 200;
      if (confirmError) throw confirmError;
    },
    blocks: async function* () {
      for (const [i, timestamp] of heads.entries()) {
        nowMs = Math.max(nowMs, ms(timestamp) + 100);
        yield { number: BigInt(i + 1), timestamp };
      }
    },
  };
  return { io, passes, confirms };
}

const last = { times: [], last: true };

test("a timed pass, then one when the last blocks start and one per block; the last vote is confirmed", async () => {
  const heads = [-11n, -9n, -7n, -5n, -3n, -1n].map((s) => flip + s);
  const steps = [sent(1), undefined, sent(2), undefined, undefined, sent(3), undefined, undefined];
  const { io, passes, confirms } = world(ms(flip - 700n), steps, { heads });
  assert.equal(await runPasses({ times: [flip - 600n], last: true }, flip, interval, io), 0);
  assert.equal(passes.length, 8, "one timed, one at the start, one per block");
  assert.deepEqual(passes[0], { at: ms(flip - 600n), until: start }, "waits for its time; until the last blocks start");
  assert.equal(passes[1]!.at, start);
  assert.ok(passes.slice(1).every((p) => p.until === ms(flip) + GRACE_MS));
  assert.deepEqual(
    confirms.map((c) => c.hash),
    [sent(1).hash, sent(3).hash],
    "the timed vote at once, then only the last vote of the last blocks",
  );
  assert.equal(confirms[1]!.until, ms(flip) + GRACE_MS);
});

test("a timed pass is retried after five seconds, not after VoteSent, and is skipped when overdue", async () => {
  const retried = world(ms(flip - 700n), [new Error("rpc"), undefined]);
  assert.equal(await runPasses({ times: [flip - 600n], last: false }, flip, interval, retried.io), 0);
  assert.deepEqual(
    retried.passes.map((p) => p.at),
    [ms(flip - 600n), ms(flip - 600n) + 400 + 5_000],
  );
  const reverted = world(ms(flip - 700n), [new VoteSent("reverted")]);
  assert.equal(await runPasses({ times: [flip - 600n], last: false }, flip, interval, reverted.io), 1);
  assert.equal(reverted.passes.length, 1);
  const overdue = world(ms(flip - 10n), [undefined, undefined], { heads: [flip - 1n] });
  assert.equal(await runPasses({ times: [flip - 10n], last: true }, flip, interval, overdue.io), 0);
  assert.equal(overdue.passes.length, 2, "the timed pass is skipped: the last blocks start first");
});

test("the next block retries; the run fails if the last pass fails before the flip, or no block appears", async () => {
  const heads = [flip - 3n, flip - 1n];
  const recovered = world(ms(flip - 20n), [undefined, new Error("rpc"), undefined], { heads });
  assert.equal(await runPasses(last, flip, interval, recovered.io), 0);
  const lastFails = world(ms(flip - 20n), [undefined, undefined, new Error("rpc")], { heads });
  assert.equal(await runPasses(last, flip, interval, lastFails.io), 1);
  const late = world(ms(flip - 20n), [undefined, new Error("stale")], { heads: [flip - 1n], passMs: 1_500 });
  assert.equal(await runPasses(last, flip, interval, late.io), 0, "a pass that fails after the flip is only logged");
  const none = world(ms(flip - 20n), [undefined]);
  assert.equal(await runPasses(last, flip, interval, none.io), 1, "no block seen");
});

test("the last vote failing to confirm fails the run", async () => {
  const { io, confirms } = world(ms(flip - 20n), [sent(1), undefined], {
    heads: [flip - 1n],
    confirmError: new VoteSent("reverted"),
  });
  assert.equal(await runPasses(last, flip, interval, io), 1);
  assert.equal(confirms.length, 1);
});

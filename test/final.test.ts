import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Address, Hex } from "viem";
import { runFinal, sleep, within, type Deps, type Outcome, type Prepared } from "../src/final.ts";

const flip = 1_790_812_800;
const arm = (flip - 20) * 1000;
const vote = { pools: ["0x0000000000000000000000000000000000000004" as Address], weights: [100n] };

type Read = { epoch: { lastVoted: bigint }; tag: string };

type Chain = {
  skew?: number; // ms after its timestamp at which a block seals
  rtt?: number;
  dead?: boolean; // polls never answer
  frozenAt?: number; // polls answer with the block pending at this wall time
  stalled?: boolean; // the pending block stays at flip - 19
  burst?: boolean; // stalled, then caught up past the flip 2 s before it
  readDead?: boolean;
  signFails?: boolean;
  signSkips?: boolean;
  lastVoted?: (now: number) => bigint;
};

/** Base-like timestamps: odd, and the block `T` is built from `T - 2` to `T`, shifted by `skew`. */
function harness(c: Chain) {
  const { skew = 0, rtt = 160 } = c;
  const pendingAt = (now: number) => {
    if (c.burst && now >= (flip - 2) * 1000) return flip + 1;
    const t = Math.floor((now - skew) / 1000) + 1;
    return Math.min(t % 2 ? t : t + 1, c.stalled || c.burst ? flip - 19 : Infinity);
  };
  const sends: { at: number; signed: string }[] = [];
  const decided: { slot: number; read: Read }[] = [];
  const deps: Deps<Read, string> = {
    poll: async () => {
      if (c.dead) return new Promise(() => {});
      const timestamp = pendingAt(Math.min(Date.now(), c.frozenAt ?? Infinity));
      await sleep(rtt);
      return { timestamp };
    },
    read: async () => {
      if (c.readDead) return new Promise(() => {});
      await sleep(150);
      return { epoch: { lastVoted: c.lastVoted?.(Date.now()) ?? 0n }, tag: "fresh" };
    },
    decide: (read, slot) => (decided.push({ slot, read }), vote),
    sign: async () => {
      await sleep(200);
      if (c.signFails) throw new Error("KMS down");
      return c.signSkips ? undefined : "signed";
    },
    send: async (signed) => {
      await sleep(100);
      sends.push({ at: Date.now(), signed });
      return `0x${sends.length.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { deps, sends, decided };
}

const prepared = (extra: Partial<Prepared<Read, string>> = {}): Prepared<Read, string> => ({
  readMs: 150,
  signMs: 200,
  ...extra,
});

/** Ticks the mocked clock 10 ms at a time until `promise` settles, at most `ms`. */
async function drive(t: TestContext, promise: Promise<Outcome>, ms = 25_000): Promise<Outcome> {
  let done = false;
  const result = promise.then((r) => ((done = true), r));
  for (let i = 0; i < ms / 10 && !done; i++) {
    t.mock.timers.tick(10);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(done, "runFinal finished");
  return result;
}

const clock = (t: TestContext, now = arm) => t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });

const inBlock = (at: number, timestamp: number) => at > (timestamp - 2) * 1000 && at <= timestamp * 1000 - 300;

test("votes in the two last blocks, each shortly before it seals, from what it sees of the chain", async (t) => {
  clock(t);
  const { deps, sends, decided } = harness({ skew: 60 });
  const { sent, errors } = await drive(t, runFinal(flip, deps, prepared()));
  assert.deepEqual(
    decided.map((d) => d.slot),
    [flip - 3, flip - 1],
  );
  assert.deepEqual([sent.length, errors], [2, 0]);
  assert.ok(inBlock(sends[0]!.at - 60, flip - 3), `first sent at ${sends[0]!.at - (flip - 3) * 1000}`);
  assert.ok(inBlock(sends[1]!.at - 60, flip - 1), `second sent at ${sends[1]!.at - (flip - 1) * 1000}`);
  assert.ok(sends[1]!.at > (flip - 1) * 1000 - 1200, "the last vote goes out within the last second");
});

test("a dead poll still votes in time, at the earliest the last blocks could be", async (t) => {
  clock(t);
  const blind = harness({ dead: true });
  await drive(t, runFinal(flip, blind.deps, prepared()));
  assert.deepEqual(
    blind.decided.map((d) => d.slot),
    [flip - 4, flip - 2],
  );
  assert.equal(blind.sends.length, 2);
  assert.ok(blind.sends.every((s) => s.at <= (flip - 2) * 1000 - 300));
});

test("a dead poll votes where a seed puts the last blocks", async (t) => {
  clock(t);
  const seeded = harness({ dead: true });
  await drive(t, runFinal(flip, seeded.deps, prepared(), [flip - 21]));
  assert.deepEqual(
    seeded.decided.map((d) => d.slot),
    [flip - 3, flip - 1],
  );
  assert.ok(inBlock(seeded.sends[1]!.at, flip - 1));
});

test("a read that hangs decides on the last read in time, and once a vote is out keeps it", async (t) => {
  clock(t);
  const snapshot = { epoch: { lastVoted: 0n }, tag: "snapshot" };
  const { deps, sends, decided } = harness({ readDead: true });
  await drive(t, runFinal(flip, deps, prepared({ snapshot })));
  assert.deepEqual(
    decided.map((d) => d.read.tag),
    ["snapshot"],
  );
  assert.equal(sends.length, 1);
  assert.ok(sends[0]!.at > (flip - 5) * 1000 && sends[0]!.at < (flip - 3) * 1000, "sent within the block");
});

test("a signature that fails sends the rehearsed vote once", async (t) => {
  clock(t);
  const { deps, sends } = harness({ signFails: true });
  const { sent, errors } = await drive(t, runFinal(flip, deps, prepared({ fallback: { vote, signed: "rehearsed" } })));
  assert.deepEqual(
    sends.map((s) => s.signed),
    ["rehearsed"],
  );
  assert.deepEqual([sent.length, errors], [1, 1], "the second block has nothing left to send");
});

test("a signature skipped sends nothing, not even the rehearsed vote", async (t) => {
  clock(t);
  const { deps, sends, decided } = harness({ signSkips: true });
  const { errors } = await drive(t, runFinal(flip, deps, prepared({ fallback: { vote, signed: "rehearsed" } })));
  assert.deepEqual([decided.length, sends.length, errors], [2, 0, 0]);
});

test("a signature that fails with nothing rehearsed sends nothing", async (t) => {
  clock(t);
  const none = harness({ signFails: true });
  assert.deepEqual(await drive(t, runFinal(flip, none.deps, prepared())), { sent: [], errors: 2 });
});

test("a vote that spilled into the block is not repeated", async (t) => {
  clock(t);
  const { deps, sends } = harness({ lastVoted: (now) => (now > (flip - 3) * 1000 ? BigInt(flip - 1) : 0n) });
  await drive(t, runFinal(flip, deps, prepared()));
  assert.equal(sends.length, 1);
});

test("a node whose view froze leaves the clock to tell a sealed block", async (t) => {
  clock(t, (flip - 3) * 1000 + 200);
  const { deps, decided, sends } = harness({ frozenAt: (flip - 8) * 1000 });
  await drive(t, runFinal(flip, deps, prepared(), [flip - 9]), 5_000);
  assert.deepEqual(
    decided.map((d) => d.slot),
    [flip - 1],
    "the penultimate block is over by the clock, whatever the frozen node says",
  );
  assert.equal(sends.length, 1);
  assert.ok(sends[0]!.at < (flip - 1) * 1000, "the last vote still goes out in time");
});

test("with no poll answering, nothing is sent once the last block could have sealed", async (t) => {
  clock(t, (flip - 1) * 1000 + 300);
  const { deps, decided, sends } = harness({ dead: true });
  await drive(t, runFinal(flip, deps, prepared(), [flip - 3]), 5_000);
  assert.deepEqual([decided.length, sends.length], [0, 0]);
});

test("a stalled chain is voted on by the clock", async (t) => {
  clock(t);
  const stalled = harness({ stalled: true });
  await drive(t, runFinal(flip, stalled.deps, prepared(), [flip - 21]));
  assert.deepEqual(
    stalled.decided.map((d) => d.slot),
    [flip - 3, flip - 1],
  );
  assert.equal(stalled.sends.length, 2);
  assert.ok(inBlock(stalled.sends[1]!.at, flip - 1));
});

test("a chain found past the flip is not voted on", async (t) => {
  clock(t);
  const burst = harness({ burst: true });
  await drive(t, runFinal(flip, burst.deps, prepared(), [flip - 21]));
  assert.deepEqual(
    burst.decided.map((d) => d.slot),
    [flip - 3, flip - 1],
  );
  assert.equal(burst.sends.length, 1, "the last vote is dropped once the chain is seen past the flip");
});

test("started late, only the last block is voted", async (t) => {
  clock(t, (flip - 1) * 1000 - 1_100);
  const { deps, decided } = harness({});
  await drive(t, runFinal(flip, deps, prepared(), [flip - 3]), 5_000);
  assert.deepEqual(
    decided.map((d) => d.slot),
    [flip - 1],
  );
});

test("within rejects once its deadline passes", async (t) => {
  clock(t);
  const hung = within(new Promise<never>(() => {}), Date.now() + 100);
  t.mock.timers.tick(100);
  await assert.rejects(hung, /timed out/);
  assert.equal(await within(Promise.resolve(1), Date.now() + 100), 1);
});

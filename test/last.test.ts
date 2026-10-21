import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex } from "viem";
import { Blocks, sleep, watch } from "../src/blocks.ts";
import type { Chain as Connection, Client } from "../src/chain.ts";
import { lastBlockBefore, outcome, race, v2Answered, type Lane, type Plan } from "../src/last.ts";
import type { Run } from "../src/pass.ts";
import { klimaSender, v2Sender, type Tx } from "../src/vote.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const flip = 1_790_812_800_000;
const start = flip - 40_000;
const numberOf = (time: number) => 1_000_000 + (time - flip - 1000) / 2000;

type Chain = { dead?: number; frozen?: number; past?: number };

/**
 * Base: a block on each odd second, built over the two seconds before it in sub-blocks 155 ms apart, the last 450 ms
 * before its timestamp. Polls take 40 ms; from `dead` they hang, from `frozen` they answer as then, and from `past` the
 * block being built is past the flip.
 */
function client({ dead = Infinity, frozen = Infinity, past = Infinity }: Chain): Client {
  const pending = (at: number) => {
    const time =
      at >= past ? flip + 1000 : flip + 1000 + 2000 * (Math.floor((Math.min(at, frozen) - flip - 1000) / 2000) + 1);
    const txs = 1 + Math.max(0, Math.min(10, Math.floor((Math.min(at, frozen) - time + 2000) / 155)));
    const hex = (n: number) => `0x${n.toString(16)}`;
    return { number: hex(numberOf(time)), timestamp: hex(time / 1000), transactions: Array<string>(txs).fill("0x") };
  };
  return {
    request: async () => {
      if (Date.now() >= dead) return new Promise(() => {});
      await sleep(20);
      const block = pending(Date.now());
      await sleep(20);
      return block;
    },
  } as unknown as Client;
}

/** Plans that take 150 ms, or that hang or fail as `behave` says for the `n`th. */
function planner(behave: (n: number) => "ok" | "hang" | "fail" = () => "ok") {
  let n = 0;
  return async (): Promise<Plan> => {
    const readAt = Date.now();
    const id = ++n;
    const behaviour = behave(id);
    if (behaviour === "hang") await new Promise(() => {});
    await sleep(150);
    if (behaviour === "fail") throw new Error("RPC timeout");
    return { readAt, time: 0, vote: null, note: `plan ${id}`, summary: {} };
  };
}

/** Ticks the mocked clock until `promise` settles. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let done = false;
  const settled = promise.finally(() => (done = true));
  for (let i = 0; i < 10_000 && !done; i++) {
    t.mock.timers.tick(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done, "settled");
  return settled;
}

type Options = {
  chain?: Chain;
  seedOnly?: boolean;
  raceAt?: number;
  behave?: Parameters<typeof planner>[0];
  /** A second lane, planning apart, and how its plans behave. */
  other?: Parameters<typeof planner>[0];
};

/** The sends of a race over the last 40 s before the flip, as ms from the flip. */
async function run(
  t: TestContext,
  { chain = {}, seedOnly, raceAt = start, behave, other }: Options = {},
  first?: Plan,
) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const blocks = new Blocks();
  const seed = flip - 41_000;
  blocks.observe({ number: BigInt(numberOf(seed)), timestamp: BigInt(seed / 1000), txs: 0 }, start);
  let watching = !seedOnly;
  const watcher = watching ? watch(client(chain), blocks, () => !watching) : Promise.resolve();
  const sent: { time: number; at: number; plan: Plan | undefined; other?: Plan | undefined }[] = [];
  const send = ([plan, second]: (Plan | undefined)[], time: number) =>
    void sent.push({ time: time - flip, at: Date.now() - flip, plan, ...(other ? { other: second } : {}) });
  const lanes: Lane<Plan>[] = [
    { name: "first", plan: planner(behave), best: first },
    ...(other ? [{ name: "other", plan: planner(other) }] : []),
  ];
  const racing = sleep(raceAt - start).then(() => race(flip, { blocks, lanes, send }));
  const sends = await drive(t, racing);
  watching = false;
  await drive(t, watcher);
  assert.equal(sends, sent.length);
  return sent;
}

/** Sent at least 150 ms before the last sub-block of its block starts, and at most 850 ms before its timestamp. */
const inTime = ({ time, at }: { time: number; at: number }) => at >= time - 850 && at <= time - 605 - 150;

const warmUp: Plan = { readAt: 0, time: 0, vote: null, note: "warm-up", summary: {} };

test("votes in the last two blocks, each just before its last sub-block starts, with a fresh plan", async (t) => {
  const sent = await run(t);
  assert.deepEqual(
    sent.map((s) => s.time),
    [-3000, -1000],
  );
  for (const s of sent) assert.ok(inTime(s), `sent ${s.at - s.time} ms from the timestamp`);
  for (const s of sent) assert.ok(s.at - (s.plan!.readAt - flip) < 300, "a fresh plan");
});

test("polls that hang or freeze leave the timing learned before to place the votes", async (t) => {
  for (const chain of [{ dead: flip - 20_000 }, { frozen: flip - 20_000 }]) {
    const sent = await run(t, { chain });
    assert.deepEqual(
      sent.map((s) => s.time),
      [-3000, -1000],
    );
    assert.ok(sent.every(inTime));
  }
});

test("with only the block seen at the start, votes half a gap before each of the last two blocks", async (t) => {
  const sent = await run(t, { seedOnly: true });
  assert.deepEqual(
    sent.map((s) => [s.time, s.at]),
    [
      [-3000, -4000],
      [-1000, -2000],
    ],
  );
});

test("a chain seen past the flip gets no more votes", async (t) => {
  const sent = await run(t, { chain: { past: flip - 2_500 } });
  assert.deepEqual(
    sent.map((s) => s.time),
    [-3000],
  );
});

test("started late, votes at once in the block still being built, and not in a sealed one", async (t) => {
  const sent = await run(t, { raceAt: flip - 1_500 });
  assert.deepEqual(
    sent.map((s) => [s.time, s.at]),
    [[-1000, -1500]],
  );
});

test("a plan that hangs is overtaken; when all hang or fail, the last that came back, or the warm-up's, is sent", async (t) => {
  const oneHangs = await run(t, { behave: (n) => (n === 3 ? "hang" : "ok") });
  for (const s of oneHangs) assert.ok(s.at - (s.plan!.readAt - flip) < 300, "a fresh plan");
  const allHang = await run(t, { behave: (n) => (n >= 5 ? "hang" : "ok") }, warmUp);
  assert.deepEqual(
    allHang.map((s) => s.plan?.note),
    ["plan 4", "plan 4"],
  );
  const allFail = await run(t, { behave: () => "fail" }, warmUp);
  assert.deepEqual(
    allFail.map((s) => s.plan?.note),
    ["warm-up", "warm-up"],
  );
  assert.ok([...allHang, ...allFail].every(inTime));
});

test("lanes plan apart: one that only fails holds back no plan of the other", async (t) => {
  const sent = await run(t, { behave: () => "fail", other: () => "ok" });
  assert.deepEqual(
    sent.map((s) => s.time),
    [-3000, -1000],
  );
  for (const s of sent) {
    assert.equal(s.plan, undefined, "the failing lane has nothing to send");
    assert.ok(s.at - (s.other!.readAt - flip) < 300, "the other lane's plan is fresh");
  }
  assert.ok(sent.every(inTime));
});

const prepared = (signed?: Hex) => ({ tx: {} as Tx, from: zeroAddress, ...(signed ? { signed } : {}) });
const v2Plan = (time: number, extra: Partial<Plan>): Plan => ({
  readAt: 0,
  time,
  vote: { pools: [], weights: [] },
  note: "",
  summary: {},
  votes: new Map([[zeroAddress, 5n]]),
  ...extra,
});

test("the Klima conduit answers only an immutable conduit's vote ready to send in the same block", () => {
  const signed = prepared("0x01");
  assert.deepEqual(v2Answered(v2Plan(9, { prepared: signed }), 9, false), new Map([[zeroAddress, 5n]]));
  assert.equal(v2Answered(undefined, 9, false), undefined, "no plan");
  assert.equal(v2Answered(v2Plan(7, { prepared: signed }), 9, false), undefined, "for an earlier block");
  assert.equal(v2Answered(v2Plan(9, {}), 9, false), undefined, "keeping its vote, or not prepared");
  assert.equal(v2Answered(v2Plan(9, { prepared: prepared() }), 9, false), undefined, "not signed: not sent");
  assert.ok(v2Answered(v2Plan(9, { prepared: prepared() }), 9, true), "a dry run plans as if it were");
});

// Base's blocks are two seconds apart, on odd seconds: block n at 1 + 2n, so the last before an even flip is at flip - 1.
const FLIP = 1_790_812_800n;
const LAST = (FLIP - 2n) / 2n;
const timeOf = (n: bigint) => 1n + 2n * n;
const [KLIMA, V2, POOL] = [addr(1), addr(2), addr(3)];

function outcomeChain(
  receipts: Record<Hex, { status: string; blockNumber: bigint }>,
  lastVoted: (conduit: string, block: bigint) => bigint,
) {
  const client = {
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = receipts[hash];
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      return { ...receipt, transactionHash: hash };
    },
    getBlock: async (args?: { blockNumber?: bigint }) => {
      const number = args?.blockNumber ?? LAST + 6n; // ten seconds after the flip
      return { number, timestamp: timeOf(number) };
    },
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: { functionName: string; args: string[] }[];
      blockNumber: bigint;
    }) =>
      contracts.map((c) =>
        c.functionName === "lastVoted"
          ? lastVoted(c.args[0]!.toLowerCase(), blockNumber)
          : c.functionName === "poolVote"
            ? POOL
            : 1n,
      ),
  } as unknown as Client;
  const chain = {
    client,
    bulk: client,
    module: addr(4),
    conduit: KLIMA,
    keeper: addr(5),
    voter: addr(6),
    ve: addr(7),
    v2: { conduit: V2, proposer: addr(8), priced: [] },
  } as unknown as Connection;
  return { chain, dryRun: false } as unknown as Run;
}

test("the last block before a time is found from the latest one", async () => {
  const run = outcomeChain({}, () => 0n);
  assert.equal(await lastBlockBefore(run.chain.client, FLIP), LAST);
  assert.equal(await lastBlockBefore(run.chain.client, FLIP - 1n), LAST - 1n, "strictly before");
});

test("each conduit's vote this epoch is read at the last block before the flip, and an open conduit's lost block is no failure", async () => {
  const vote = { pools: [POOL], weights: [1n] };
  const [klimaHash, v2Hash]: [Hex, Hex] = ["0xaa", "0xbb"];
  const run = outcomeChain(
    { [klimaHash]: { status: "success", blockNumber: LAST }, [v2Hash]: { status: "reverted", blockNumber: LAST - 1n } },
    // Someone voted for the immutable conduit first in our block, and again after the flip.
    (conduit, block) => (conduit === V2 ? (block > LAST ? FLIP + 1n : timeOf(LAST - 1n)) : timeOf(LAST)),
  );
  const sent = [
    { hash: klimaHash, vote, nonce: 1, sender: klimaSender(run.chain) },
    { hash: v2Hash, vote, nonce: 1, sender: v2Sender(run.chain) },
  ];
  assert.equal(await outcome(run, FLIP, sent, [KLIMA, V2]), 0);
  const reverted = outcomeChain({ [klimaHash]: { status: "reverted", blockNumber: LAST } }, () => timeOf(LAST - 5n));
  assert.equal(
    await outcome(reverted, FLIP, [{ ...sent[0]!, sender: klimaSender(reverted.chain) }], [KLIMA]),
    1,
    "the Klima conduit's revert fails",
  );
});

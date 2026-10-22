import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex } from "viem";
import { Blocks, sleep, watch } from "../src/blocks.ts";
import { lastBlockBefore, type Chain as Connection, type Client } from "../src/chain.ts";
import {
  keep,
  landed,
  outcome,
  pick,
  race,
  refreshed,
  reusable,
  v2Answered,
  type Lane,
  type Plan,
} from "../src/last.ts";
import type { Run } from "../src/pass.ts";
import { klimaSender, v2Sender, type Tx } from "../src/vote.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const flip = 1_790_812_800_000;
const start = flip - 40_000;
const numberOf = (time: number) => 1_000_000 + (time - flip - 1000) / 2000;

type Chain = { dead?: number; frozen?: number; past?: number };

/**
 * Fakes Base's timing: a block every odd second, built in sub-blocks 155 ms apart, the last one 450 ms before the
 * block's timestamp. Polls take 40 ms. They hang from `dead`, stop advancing from `frozen`, and see a block after the
 * flip from `past`.
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

function planner(behave: (n: number) => "ok" | "hang" | "fail" = () => "ok") {
  let n = 0;
  return async (): Promise<Plan> => {
    const readAt = Date.now();
    const id = ++n;
    const behaviour = behave(id);
    if (behaviour === "hang") await new Promise(() => {});
    await sleep(150);
    if (behaviour === "fail") throw new Error(`NotBetter(${id}, ${id + 1})`);
    return { readAt, time: 0, vote: null, note: `plan ${id}`, summary: {} };
  };
}

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
  /** Adds a second lane whose plans behave this way. */
  other?: Parameters<typeof planner>[0];
};

/** Runs a race over the last 40 s before the flip and returns its sends, timed in ms from the flip. */
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
  const lanes: Lane<Plan>[] = [
    { name: "first", plan: planner(behave), best: first },
    ...(other ? [{ name: "other", plan: planner(other) }] : []),
  ];
  const send = (time: number) =>
    void sent.push({
      time: time - flip,
      at: Date.now() - flip,
      plan: lanes[0]!.best,
      ...(other ? { other: lanes[1]!.best } : {}),
    });
  const racing = sleep(raceAt - start).then(() => race(flip, { blocks, lanes, send }));
  const sends = await drive(t, racing);
  watching = false;
  await drive(t, watcher);
  assert.equal(sends, sent.length);
  return sent;
}

/** Whether a send came between 850 ms before its block's timestamp and 150 ms before the block's last sub-block. */
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

test("a lane whose plans keep failing alike is warned about once, whatever numbers its errors carry", async (t) => {
  const write = t.mock.method(process.stdout, "write", () => true);
  await run(t, { behave: () => "fail" });
  const warned = write.mock.calls.filter((call) => String(call.arguments[0]).includes('"plan failed"'));
  write.mock.restore();
  assert.equal(warned.length, 1);
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

const [voteA, voteB] = [
  { pools: [addr(10)], weights: [1n] },
  { pools: [addr(11)], weights: [1n] },
];
const planned = (readAt: number, vote: typeof voteA | null, rival?: typeof voteA, time = 9): Plan => ({
  readAt,
  time,
  vote,
  note: "",
  summary: {},
  ...(vote ? { prepared: prepared("0x01") } : {}),
  ...(rival ? { rival } : {}),
});
const laneOf = (...plans: Plan[]) => {
  const lane: Lane<Plan> = { name: "", plan: () => new Promise(() => {}) };
  for (const plan of plans) keep(lane, plan);
  return lane;
};
const readAts = ({ klima, v2, unchecked }: ReturnType<typeof pick>) => ({
  klima: klima?.readAt,
  v2: v2?.readAt,
  ...(unchecked ? { unchecked } : {}),
});

test("each conduit sends its freshest plan for the block when the immutable conduit's was checked after the Klima conduit's", () => {
  const klima = laneOf(planned(100, voteA), planned(300, voteA));
  const v2 = laneOf(planned(200, voteB, voteA), planned(400, voteB, voteA));
  assert.deepEqual(readAts(pick(9, klima, v2)), { klima: 300, v2: 400 });
  const keeping = laneOf(planned(300, null));
  assert.deepEqual(readAts(pick(9, keeping, v2)), { klima: 300, v2: 400 }, "the Klima conduit keeps its vote");
  const v2Keeps = laneOf(planned(400, null));
  assert.deepEqual(readAts(pick(9, klima, v2Keeps)), { klima: 300, v2: 400 }, "the immutable conduit keeps its own");
  assert.deepEqual(readAts(pick(9, undefined, v2)), { klima: undefined, v2: 400 }, "no Klima conduit to vote for");
  assert.deepEqual(readAts(pick(9, laneOf(), v2)), { klima: undefined, v2: 400 }, "nothing planned for the Klima one");
  assert.deepEqual(readAts(pick(9, klima, undefined)), { klima: 300, v2: undefined }, "no immutable conduit");
});

test("the immutable conduit's vote goes only with a Klima conduit's vote it was checked after", () => {
  // The Klima conduit switched to voteB at 300, and no immutable conduit plan has been checked after that vote yet.
  const klima = laneOf(planned(100, voteA), planned(300, voteB));
  const v2 = laneOf(planned(50, voteB), planned(350, voteB, voteA));
  assert.deepEqual(readAts(pick(9, klima, v2)), { klima: 100, v2: 350 }, "the freshest pair checked together");
  const changed = laneOf(planned(300, voteB));
  assert.deepEqual(readAts(pick(9, changed, v2)), { klima: 300, v2: undefined, unchecked: true }, "none");
  const before = laneOf(planned(50, voteA, undefined, 7));
  assert.deepEqual(readAts(pick(9, before, v2)), { klima: 50, v2: 350 }, "a Klima vote of an earlier block counts");
});

test("alone, the Klima conduit sends its freshest plan that answered the immutable conduit's votes in force", () => {
  // The immutable conduit's only plan was checked after a Klima vote from an earlier block, so it isn't sent. The Klima
  // plan at 300 answered that plan, and the one at 100 answered the votes already in force.
  const v2 = laneOf(planned(250, voteB, voteB));
  const answering = { ...planned(300, voteA), answered: true };
  const picked = pick(9, laneOf({ ...planned(100, voteA), answered: false }, answering), v2);
  assert.deepEqual(readAts(picked), { klima: 100, v2: undefined, unchecked: true });
  assert.equal(picked.freshest?.readAt, 300, "its freshest, reported");
  const allAnswering = pick(9, laneOf({ ...planned(100, voteA), answered: true }, answering), v2);
  assert.deepEqual(readAts(allAnswering), { klima: 300, v2: undefined, unchecked: true }, "else its freshest");
});

test("the immutable conduit's values: the last read, read again in the background once per block", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let reads = 0;
  let fails = false;
  const answers: (() => void)[] = [];
  const read = () =>
    new Promise<number>((resolve, reject) => {
      const n = ++reads;
      answers.push(() => (fails ? reject(new Error("timeout")) : resolve(n)));
    });
  const unread: unknown[] = [];
  const values = refreshed(read, (error) => unread.push(error));
  const answer = async () => {
    answers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const first = values(1);
  await answer();
  assert.deepEqual(await first, { value: 1, version: 1 }, "the first call waits");
  assert.deepEqual(await values(1), { value: 1, version: 1 });
  assert.equal(reads, 1, "once per block");
  assert.deepEqual(await values(3), { value: 1, version: 1 }, "the last values while the next block's are read");
  await values(5);
  assert.equal(reads, 2, "one read at a time");
  await answer();
  assert.deepEqual(await values(5), { value: 2, version: 2 });
  fails = true;
  await answer();
  assert.equal(unread.length, 1);
  assert.deepEqual(await values(5), { value: 2, version: 2 }, "the last values after a read fails");
  assert.equal(reads, 3, "not read again at once");
  t.mock.timers.tick(500);
  await values(5);
  assert.equal(reads, 4, "read again shortly after");
});

test("plans wait for the immutable conduit's first values only so long, and go without while they are read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let answer: (value: number) => void = () => {};
  const values = refreshed(
    () => new Promise<number>((resolve) => (answer = resolve)),
    () => {},
    3_000,
  );
  const first = values(1);
  t.mock.timers.tick(3_000);
  assert.equal(await first, undefined, "a read that hangs holds back no plan");
  const second = values(1);
  t.mock.timers.tick(3_000);
  assert.equal(await second, undefined, "nor any later one before it answers");
  answer(7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await values(1), { value: 7, version: 1 }, "the values once read");
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

test("an immutable conduit's vote is known to be in once the Voter shows its votes on every pool", () => {
  const [a, b] = [addr(7), addr(8)];
  const vote = { pools: [a], weights: [1n] };
  const sent = (nonce: number, votes: [Address, bigint][]) => ({
    hash: "0x01" as Hex,
    vote,
    nonce,
    sender: v2Sender({ v2: { conduit: addr(2), proposer: addr(9), priced: [] } } as unknown as Connection),
    votes: new Map(votes),
  });
  const state = (v2Votes: [bigint, bigint], votedThisEpoch = true) => ({
    epoch: {
      start: 0n,
      flip: 0n,
      power: 1n,
      lastVoted: 0n,
      votedThisEpoch,
      v2: { power: 1n, lastVoted: 0n, votedThisEpoch },
    },
    pools: [a, b].map((pool, i) => ({ pool, rewards: [], otherVotes: 0n, ownVotes: 0n, v2Votes: v2Votes[i]! })),
  });
  const votes = [
    sent(7, [[a, 10n]]),
    sent(8, [
      [a, 6n],
      [b, 4n],
    ]),
  ];
  assert.deepEqual(landed(state([6n, 4n]), votes), [8]);
  assert.deepEqual(landed(state([10n, 0n]), votes), [7], "a pool it leaves out has no votes");
  assert.deepEqual(landed(state([5n, 5n]), votes), [], "someone else's vote");
  assert.deepEqual(landed(state([6n, 4n], false), votes), [], "votes of an earlier epoch");
  const klima = {
    ...sent(9, []),
    sender: klimaSender({ keeper: addr(5), module: addr(6), conduit: addr(1) } as Connection),
  };
  assert.deepEqual(landed(state([0n, 0n]), [{ ...klima, votes: undefined }]), [], "not the immutable conduit's");
});

// Block n has timestamp 1 + 2n, so blocks fall on odd seconds and the last one before an even flip is at flip - 1.
const FLIP = 1_790_812_800n;
const LAST = (FLIP - 2n) / 2n;
const timeOf = (n: bigint) => 1n + 2n * n;
const [KLIMA, V2, POOL] = [addr(1), addr(2), addr(3)];

/** For the first `behind` reads, the latest block is still before the flip. */
function outcomeChain(
  receipts: Record<Hex, { status: string; blockNumber: bigint }>,
  lastVoted: (conduit: string, block: bigint) => bigint,
  behind = 0,
) {
  const client = {
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = receipts[hash];
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      return { ...receipt, transactionHash: hash };
    },
    getBlock: async (args?: { blockNumber?: bigint }) => {
      const number = args?.blockNumber ?? (behind-- > 0 ? LAST - 1n : LAST + 6n); // 11 s after the flip
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
    // Someone else voted for the immutable conduit earlier in our vote's block, and again after the flip.
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

test("whether each conduit voted this epoch is read again while the node is behind, and unread fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lagging = (behind: number) => outcomeChain({}, () => timeOf(LAST), behind);
  await assert.rejects(lastBlockBefore(lagging(1).chain.client, FLIP), /not past/);
  assert.equal(await drive(t, outcome(lagging(2), FLIP, [], [KLIMA])), 0, "read at the third try");
  assert.equal(await drive(t, outcome(lagging(3), FLIP, [], [KLIMA])), 1, "unread");
});

test("a prepared vote is reused only for the same block, votes and rival, and the same last vote on chain", () => {
  const vote = { pools: [addr(1)], weights: [1n] };
  const plan = (more: Partial<Plan> = {}): Plan => ({
    readAt: 0,
    time: flip - 1000,
    vote,
    note: "",
    summary: {},
    ...more,
  });
  const best = plan({ prepared: { tx: {} as Tx, from: addr(9), lastVoted: 5n } });
  assert.equal(reusable(best, plan({ readAt: 500 }), 5n), true);
  assert.equal(reusable(best, plan(), 7n), false, "a vote landed since, and may have taken its nonce");
  assert.equal(reusable(best, plan({ time: flip - 3000 }), 5n), false, "another block");
  assert.equal(reusable(best, plan({ vote: { pools: [addr(2)], weights: [1n] } }), 5n), false, "other votes");
  assert.equal(reusable(best, plan(), 5n, vote), false, "checked after no rival vote");
  assert.equal(reusable(plan(), plan(), 5n), false, "nothing prepared");
  assert.equal(reusable(undefined, plan(), 5n), false);
});

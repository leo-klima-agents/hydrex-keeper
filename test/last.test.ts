import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { encodeFunctionData, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex } from "viem";
import { voterAbi } from "../src/abi.ts";
import { Blocks, sleep, watch } from "../src/blocks.ts";
import { lastBlockBefore, type Chain as Connection, type Client } from "../src/chain.ts";
import {
  decideBoth,
  keep,
  landed,
  lastVotes,
  oncePer,
  outcome,
  pick,
  race,
  refreshed,
  votedInSecond,
  type Lane,
  type Plan,
} from "../src/last.ts";
import type { Run } from "../src/pass.ts";
import type { State } from "../src/read.ts";
import { immutableSender, klimaSender, type Tx } from "../src/vote.ts";
import { logged } from "./helpers.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const flip = 1_790_812_800_000;
const start = flip - 40_000;
const numberOf = (time: number) => 1_000_000 + (time - flip) / 200;

type Chain = { dead?: number; frozen?: number; past?: number; seal?: number };

/**
 * Fakes Base's timing: a block every 200 ms, first seen `seal` ms after its time. Polls take 40 ms. They hang from
 * `dead`, stop advancing from `frozen`, and see a block after the flip from `past`.
 */
function client({ dead = Infinity, frozen = Infinity, past = Infinity, seal = 0 }: Chain): Client {
  const latest = (at: number) => {
    const time = at >= past ? flip + 200 : 200 * Math.floor((Math.min(at, frozen) - seal) / 200);
    const hex = (n: number) => `0x${n.toString(16)}`;
    return {
      number: hex(numberOf(time)),
      timestamp: hex(Math.floor(time / 1000)),
      timestampMs: hex(time),
      transactions: [],
    };
  };
  return {
    request: async () => {
      if (Date.now() >= dead) return new Promise(() => {});
      await sleep(20);
      const block = latest(Date.now());
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
  blocks.observe({ number: BigInt(numberOf(seed)), time: seed }, start);
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

/** Whether a send came at its deadline, 400 ms before its block's time. */
const inTime = ({ time, at }: { time: number; at: number }) => at >= time - 400 && at <= time - 380;

const warmUp: Plan = { readAt: 0, time: 0, vote: null, note: "warm-up", summary: {} };

test("votes once in each of the last two seconds, in the block before each second's last, with a fresh plan", async (t) => {
  const sent = await run(t);
  assert.deepEqual(
    sent.map((s) => s.time),
    [-1400, -400],
  );
  for (const s of sent) assert.ok(inTime(s), `sent ${s.at - s.time} ms from its block's time`);
  for (const s of sent) assert.ok(s.at - (s.plan!.readAt - flip) < 300, "a fresh plan");
});

test("polls that hang or freeze leave the timing learned before to place the votes", async (t) => {
  for (const chain of [{ dead: flip - 20_000 }, { frozen: flip - 20_000 }]) {
    const sent = await run(t, { chain });
    assert.deepEqual(
      sent.map((s) => s.time),
      [-1400, -400],
    );
    assert.ok(sent.every(inTime));
  }
});

test("blocks seen before their time get votes sent earlier, and blocks seen late none later", async (t) => {
  const early = await run(t, { chain: { seal: -100 } });
  assert.deepEqual(
    early.map((s) => s.time),
    [-1400, -400],
  );
  for (const s of early) assert.ok(s.at >= s.time - 500 && s.at < s.time - 400, `sent ${s.at - s.time} ms before`);
  const late = await run(t, { chain: { seal: 300 } });
  assert.ok(late.length === 2 && late.every(inTime));
});

test("with only the block seen at the start, votes at Base's block time", async (t) => {
  const sent = await run(t, { seedOnly: true });
  assert.deepEqual(
    sent.map((s) => [s.time, s.at]),
    [
      [-1400, -1800],
      [-400, -800],
    ],
  );
});

test("a chain seen past the flip gets no more votes", async (t) => {
  const sent = await run(t, { chain: { past: flip - 1_500 } });
  assert.deepEqual(
    sent.map((s) => s.time),
    [-1400],
  );
});

test("started late, votes at once in a block still open, and never in a sealed one", async (t) => {
  const late = await run(t, { raceAt: flip - 1_500 });
  assert.deepEqual(
    late.map((s) => [s.time, s.at]),
    [
      [-1400, -1500],
      [-400, -800],
    ],
  );
  assert.deepEqual(await run(t, { raceAt: flip - 350 }), [], "the last second's block is sealed");
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
    [-1400, -400],
  );
  for (const s of sent) {
    assert.equal(s.plan, undefined, "the failing lane has nothing to send");
    assert.ok(s.at - (s.other!.readAt - flip) < 300, "the other lane's plan is fresh");
  }
  assert.ok(sent.every(inTime));
});

test("a lane whose plans keep failing alike is warned about once, whatever numbers its errors carry", async (t) => {
  const lines = await logged(t, () => run(t, { behave: () => "fail" }));
  assert.equal(lines.filter((line) => line.message === "plan failed").length, 1);
});

const prepared = (signed?: Hex) => ({ tx: {} as Tx, from: zeroAddress, ...(signed ? { signed } : {}) });
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
const readAts = ({ klima, immutable, unchecked }: ReturnType<typeof pick>) => ({
  klima: klima?.readAt,
  immutable: immutable?.readAt,
  ...(unchecked ? { unchecked } : {}),
});

test("each conduit sends its freshest plan for the block when the immutable conduit's was checked after the Klima conduit's", () => {
  const klima = laneOf(planned(100, voteA), planned(300, voteA));
  const immutable = laneOf(planned(200, voteB, voteA), planned(400, voteB, voteA));
  assert.deepEqual(readAts(pick(9, klima, immutable)), { klima: 300, immutable: 400 });
  const keeping = laneOf(planned(300, null));
  assert.deepEqual(
    readAts(pick(9, keeping, immutable)),
    { klima: 300, immutable: 400 },
    "the Klima conduit keeps its vote",
  );
  const immutableKeeps = laneOf(planned(400, null));
  assert.deepEqual(
    readAts(pick(9, klima, immutableKeeps)),
    { klima: 300, immutable: 400 },
    "the immutable conduit keeps its own",
  );
  assert.deepEqual(
    readAts(pick(9, undefined, immutable)),
    { klima: undefined, immutable: 400 },
    "no Klima conduit to vote for",
  );
  assert.deepEqual(
    readAts(pick(9, laneOf(), immutable)),
    { klima: undefined, immutable: 400 },
    "nothing planned for the Klima one",
  );
  assert.deepEqual(
    readAts(pick(9, klima, undefined)),
    { klima: 300, immutable: undefined },
    "no vote for the immutable conduit",
  );
});

test("the immutable conduit's vote goes only with a Klima conduit's vote it was checked after", () => {
  // The Klima conduit switched to voteB at 300, and no immutable conduit plan has been checked after that vote yet.
  const klima = laneOf(planned(100, voteA), planned(300, voteB));
  const immutable = laneOf(planned(50, voteB), planned(350, voteB, voteA));
  assert.deepEqual(
    readAts(pick(9, klima, immutable)),
    { klima: 100, immutable: 350 },
    "the freshest pair checked together",
  );
  const changed = laneOf(planned(300, voteB));
  assert.deepEqual(readAts(pick(9, changed, immutable)), { klima: 300, immutable: undefined, unchecked: true }, "none");
  const before = laneOf(planned(50, voteA, undefined, 7));
  assert.deepEqual(
    readAts(pick(9, before, immutable)),
    { klima: 50, immutable: 350 },
    "a Klima vote of an earlier block counts",
  );
});

test("alone, the Klima conduit sends its freshest plan that answered the immutable conduit's votes in force", () => {
  // The immutable conduit's only plan was checked after a Klima vote from an earlier block, so it isn't sent. The Klima
  // plan at 300 answered that plan, and the one at 100 answered the votes already in force.
  const immutable = laneOf(planned(250, voteB, voteB));
  const answering = { ...planned(300, voteA), answered: true };
  const picked = pick(9, laneOf({ ...planned(100, voteA), answered: false }, answering), immutable);
  assert.deepEqual(readAts(picked), { klima: 100, immutable: undefined, unchecked: true });
  assert.equal(picked.freshest?.readAt, 300, "its freshest, reported");
  const allAnswering = pick(9, laneOf({ ...planned(100, voteA), answered: true }, answering), immutable);
  assert.deepEqual(readAts(allAnswering), { klima: 300, immutable: undefined, unchecked: true }, "else its freshest");
});

test("the immutable conduit's values: the last read, read again in the background once per key", async (t) => {
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
  assert.equal(reads, 1, "once per key");
  assert.deepEqual(await values(3), { value: 1, version: 1 }, "the last values while new ones are read");
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

test("both votes come from one read, so that the plans made from it pair up, the Klima one answering the other", () => {
  const E = 10n ** 18n;
  const [a, b] = [addr(20), addr(21)];
  const time = flip - 400;
  const second = BigInt(Math.floor(time / 1000));
  const state = ({ klimaVoted = 0n, immutableVoted = 0n } = {}): State => ({
    epoch: {
      start: 0n,
      flip: 0n,
      power: 1000n * E,
      lastVoted: klimaVoted,
      votedThisEpoch: true,
      immutable: { power: 1000n * E, lastVoted: immutableVoted, votedThisEpoch: false },
    },
    pools: [
      { pool: a, rewards: [], otherVotes: 2000n * E, ownVotes: 0n, immutableVotes: 0n },
      { pool: b, rewards: [], otherVotes: 100n * E, ownVotes: 0n, immutableVotes: 0n },
    ],
  });
  const usd = [300, 100];
  const conduits = { klima: true, immutable: true, trusted: true };
  const both = decideBoth(state(), time, usd, undefined, conduits);
  assert.ok(both.immutable.vote && both.klima.vote);
  assert.equal(both.answered, true);
  assert.deepEqual(both.rival, both.klima.vote, "the immutable conduit's vote is checked after the Klima one");
  const inForce = decideBoth(state(), time, usd, undefined, { ...conduits, trusted: false });
  assert.equal(inForce.answered, false, "while the immutable conduit's plans fail");
  assert.notDeepEqual(inForce.klima.vote, both.klima.vote, "the Klima conduit then answers the votes in force");
  assert.deepEqual(inForce.rival, inForce.klima.vote);
  const voted = decideBoth(state({ immutableVoted: second }), time, usd, undefined, conduits);
  assert.equal(voted.answered, false, "the immutable conduit already voted in the block's second");
  const klimaVoted = decideBoth(state({ klimaVoted: second }), time, usd, undefined, conduits);
  assert.equal(klimaVoted.rival, undefined, "no Klima vote goes out in that second");
  assert.equal(decideBoth(state(), time, usd, undefined, { ...conduits, klima: false }).rival, undefined);
  // Plans made from the same read, by either lane, pair up.
  const plans = (d: typeof both, readAt: number) => ({
    klima: laneOf({ ...planned(readAt, d.klima.vote, undefined, time), answered: d.answered }),
    immutable: laneOf(planned(readAt, d.immutable.vote, d.rival, time)),
  });
  const fresh = plans(both, 500);
  assert.deepEqual(readAts(pick(time, fresh.klima, fresh.immutable)), { klima: 500, immutable: 500 });
  const stale = plans(inForce, 400);
  const mixed = pick(time, fresh.klima, stale.immutable);
  assert.deepEqual(readAts(mixed), { klima: 500, immutable: undefined, unchecked: true }, "not across reads");
});

test("plans with the same inputs share one preparation, finished or under way, and a failed one is made again", async () => {
  const prepare = oncePer<number>(2);
  let made = 0;
  const make =
    (value: number, fail = false) =>
    async () => {
      made++;
      await new Promise((resolve) => setImmediate(resolve));
      if (fail) throw new Error("reverted");
      return value;
    };
  const [first, second] = [prepare("a", make(1)), prepare("a", make(2))];
  assert.deepEqual([await first, await second, made], [1, 1, 1], "under way");
  assert.deepEqual([await prepare("a", make(3)), made], [1, 1], "finished");
  await assert.rejects(prepare("b", make(4, true)), /reverted/);
  assert.deepEqual([await prepare("b", make(5)), made], [5, 3], "a failure is forgotten");
  await prepare("c", make(6));
  assert.deepEqual([await prepare("a", make(7)), made], [7, 5], "only the last ones are kept");
});

test("an immutable conduit's vote is known to be in once the Voter shows its votes on every pool", () => {
  const [a, b] = [addr(7), addr(8)];
  const vote = { pools: [a], weights: [1n] };
  const sent = (nonce: number, votes: [Address, bigint][]) => ({
    hash: "0x01" as Hex,
    vote,
    nonce,
    sender: immutableSender({
      immutable: { conduit: addr(2), proposer: addr(9), priced: [] },
    } as unknown as Connection),
    votes: new Map(votes),
  });
  const state = (immutableVotes: [bigint, bigint], votedThisEpoch = true) => ({
    epoch: {
      start: 0n,
      flip: 0n,
      power: 1n,
      lastVoted: 0n,
      votedThisEpoch,
      immutable: { power: 1n, lastVoted: 0n, votedThisEpoch },
    },
    pools: [a, b].map((pool, i) => ({
      pool,
      rewards: [],
      otherVotes: 0n,
      ownVotes: 0n,
      immutableVotes: immutableVotes[i]!,
    })),
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

// As on Base, block n comes at 200n ms, so five blocks share each second and the last one before the flip is 200 ms
// before it.
const FLIP = 1_790_812_800n;
const LAST = FLIP * 5n - 1n;
const timeOf = (n: bigint) => n / 5n;
const [KLIMA, IMMUTABLE, POOL, VOTER] = [addr(1), addr(2), addr(3), addr(6)];
let blockReads = 0;

type Receipt = {
  status: string;
  blockNumber: bigint;
  transactionIndex?: number;
  from?: Address;
  to?: Address;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
};
type Voted = { transactionHash: Hex; args: { voter: Address } };
const BASE_FEE = 5_000_000n;

/** For the first `behind` reads, the latest block is still before the flip. */
function outcomeChain(
  receipts: Record<Hex, Receipt>,
  lastVoted: (conduit: string, block: bigint) => bigint,
  behind = 0,
  events: Voted[] = [],
  ranges: [bigint, bigint][] = [],
  inputs: Record<Hex, Hex> = {},
) {
  const client = {
    getTransaction: async ({ hash }: { hash: Hex }) => ({
      to: receipts[hash]?.to ?? null,
      input: inputs[hash] ?? "0x",
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = receipts[hash];
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      return { ...receipt, transactionHash: hash };
    },
    getBlock: async (args?: { blockNumber?: bigint }) => {
      blockReads++;
      const number = args?.blockNumber ?? (behind-- > 0 ? LAST - 1n : LAST + 56n); // 11 s after the flip
      const timestampMs = `0x${(200n * number).toString(16)}`;
      return {
        number,
        timestamp: timeOf(number),
        timestampMs,
        baseFeePerGas: BASE_FEE,
        gasUsed: 12_000_000n,
        gasLimit: 40_000_000n,
      };
    },
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      return events;
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
    immutable: { conduit: IMMUTABLE, proposer: addr(8), priced: [] },
  } as unknown as Connection;
  return { chain, dryRun: false } as unknown as Run;
}

test("the last block before a time is worked out from the latest one's time in ms, then checked", async () => {
  const run = outcomeChain({}, () => 0n);
  blockReads = 0;
  assert.equal(await lastBlockBefore(run.chain.client, FLIP), LAST);
  assert.equal(blockReads, 3, "the latest block, then the one found and the one after it");
  assert.equal(await lastBlockBefore(run.chain.client, FLIP - 1n), LAST - 5n, "strictly before");
});

test("each conduit's vote this epoch is read at the last block before the flip, and an open conduit's lost second is no failure", async () => {
  const vote = { pools: [POOL], weights: [1n] };
  const [klimaHash, immutableHash]: [Hex, Hex] = ["0xaa", "0xbb"];
  const run = outcomeChain(
    {
      [klimaHash]: { status: "success", blockNumber: LAST },
      [immutableHash]: { status: "reverted", blockNumber: LAST - 1n },
    },
    // Someone else voted for the immutable conduit two blocks before ours, in its second, and again after the flip.
    (conduit, block) => (conduit === IMMUTABLE ? (block > LAST ? FLIP + 1n : timeOf(LAST - 3n)) : timeOf(LAST)),
  );
  const sent = [
    { hash: klimaHash, vote, nonce: 1, sender: klimaSender(run.chain) },
    { hash: immutableHash, vote, nonce: 1, sender: immutableSender(run.chain) },
  ];
  assert.equal(await outcome(run, FLIP, sent, [KLIMA, IMMUTABLE]), 0);
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

test("each vote that landed is logged against the block it was sent for, when it was sent, and its block", async (t) => {
  const vote = { pools: [POOL], weights: [1n] };
  const hash: Hex = "0xaa";
  const receipt = {
    status: "success",
    blockNumber: LAST - 2n,
    transactionIndex: 3,
    gasUsed: 6_000_000n,
    effectiveGasPrice: BASE_FEE + 20_000_000n,
  };
  const run = outcomeChain({ [hash]: receipt }, () => timeOf(LAST));
  const flipMs = Number(FLIP) * 1000;
  const sender = klimaSender(run.chain);
  const sent = [{ hash, vote, nonce: 1, sender, target: flipMs - 400, sentAt: flipMs - 840, gas: 9_000_000n }];
  const lines = await logged(t, () => outcome(run, FLIP, sent, [KLIMA]));
  const { msToFlip, msAfterTarget, msAfterSend, index, gasUsed, gasLimit, tip, blockGasUsed, blockGasLimit } =
    lines.find((l) => l.message === "vote landed")!;
  assert.deepEqual(
    { msToFlip, msAfterTarget, msAfterSend, index, gasUsed, gasLimit, tip, blockGasUsed, blockGasLimit },
    {
      msToFlip: -600,
      msAfterTarget: -200,
      msAfterSend: 240,
      index: 3,
      gasUsed: "6000000",
      gasLimit: "9000000",
      tip: "20000000",
      blockGasUsed: "12000000",
      blockGasLimit: "40000000",
    },
  );
});

test("every vote of the last 10 s before the flip is logged, anyone's, in the order it landed", async (t) => {
  const OTHER = addr(9);
  const receipts: Record<Hex, Receipt> = {
    "0x01": {
      status: "success",
      blockNumber: LAST - 3n,
      transactionIndex: 7,
      from: addr(10),
      to: VOTER,
      gasUsed: 4_000_000n,
      effectiveGasPrice: BASE_FEE + 6_000_000n,
    },
    "0x02": {
      status: "success",
      blockNumber: LAST - 1n,
      transactionIndex: 2,
      from: addr(5),
      to: addr(4),
      gasUsed: 6_000_000n,
      effectiveGasPrice: BASE_FEE + 20_000_000n,
    },
  };
  const events: Voted[] = [
    { transactionHash: "0x02", args: { voter: KLIMA } },
    { transactionHash: "0x01", args: { voter: OTHER } },
    { transactionHash: "0x01", args: { voter: OTHER } },
  ];
  const ranges: [bigint, bigint][] = [];
  // A poke straight to the Voter, and the keeper's vote through the module.
  const inputs: Record<Hex, Hex> = {
    "0x01": encodeFunctionData({ abi: voterAbi, functionName: "poke" }),
    "0x02": "0xdeadbeef0000",
  };
  const run = outcomeChain(receipts, () => 0n, 0, events, ranges, inputs);
  const lines = await logged(t, () => lastVotes(run, FLIP));
  assert.deepEqual(ranges, [[LAST - 49n, LAST]], "the blocks of the last 10 s");
  assert.deepEqual(
    lines
      .filter((l) => l.message === "vote before the flip")
      .map(({ hash, voter, ours, call, pools, msToFlip, index, tip }) => [
        hash,
        voter,
        ours,
        call,
        pools,
        msToFlip,
        index,
        tip,
      ]),
    [
      ["0x01", OTHER, false, "poke", 2, -800, 7, "6000000"],
      ["0x02", KLIMA, true, "0xdeadbeef", 1, -400, 2, "20000000"],
    ],
  );
  const summary = lines.find((l) => l.message === "votes before the flip");
  const counts = { seconds: "10", votes: 2, others: 1, pokes: 1 };
  assert.deepEqual(summary, { severity: "INFO", message: "votes before the flip", ...counts });
});

test("a conduit already voted in a block's second once its last vote is in that second or later", () => {
  const flipMs = Number(FLIP) * 1000;
  assert.equal(votedInSecond(FLIP - 1n, flipMs - 400), true, "the last second, at its fourth block");
  assert.equal(votedInSecond(FLIP - 1n, flipMs - 1_000), true, "the last second, at its first block");
  assert.equal(votedInSecond(FLIP - 2n, flipMs - 400), false, "the second before");
  assert.equal(votedInSecond(FLIP - 1n, flipMs - 1_200), true, "a later second than the block's");
});

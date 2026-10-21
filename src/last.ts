import {
  keccak256,
  serializeTransaction,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { Blocks, sleep, watch } from "./blocks.ts";
import { lastBlockBefore, lower, readMany, voterCall, WEEK, type Chain } from "./chain.ts";
import { decideV2, pricedPools, readScore, readValues } from "./immutable.ts";
import { errorKind, errorMessage, log, warnOnce } from "./log.ts";
import { tokensOf, valueRewards, type Run } from "./pass.ts";
import type { Prices } from "./prices.ts";
import { assertFresh, readRewards, readVotes, type PoolRewards, type State } from "./read.ts";
import { select, summarize, type Vote } from "./select.ts";
import {
  broadcastTx,
  klimaSender,
  lastVotedAt,
  markMined,
  nonceTaken,
  prepareVote,
  v2Sender,
  verifyVote,
  type Prepared,
  type Rival,
  type Sender,
} from "./vote.ts";

const WARMUP_MS = 60_000; // the pass starts this long before the flip, to learn the block timing
const PRICES_BY_MS = 5_000; // before the flip
const TICK_MS = 50;
const PLAN_EVERY_MS = 100;
const MAX_PLANS = 3; // in flight, per lane
const RECENT = 30; // plans kept per lane: more than come back for one block
const RETRY_DELAY_MS = 5_000;
const SHARED_READ_MS = 50; // the lanes share a read of the votes started this recently
const REREAD_MS = 500; // after a read of the immutable conduit's values fails
const FIRST_READ_WAIT_MS = 3_000; // the longest a plan waits for the immutable conduit's first values
const SETTLE_MS = 10_000; // after the flip, so that lagging RPCs have the last blocks
const OUTCOME_TRIES = 3;
const OUTCOME_RETRY_MS = 2_000;

/** A vote sent, and for the immutable conduit, its votes on each pool once it lands, by lowercase pool. */
export type Sent = { hash: Hex; vote: Vote; nonce: number; sender: Sender; votes?: Map<Address, bigint> | undefined };

/** What to send for one conduit in the block with timestamp `time` (ms), from a read at `readAt` (ms). */
export type Plan = {
  readAt: number;
  time: number;
  vote: Vote | null;
  note: string;
  prepared?: Prepared;
  /** The immutable conduit's votes on each pool once its vote lands, by lowercase pool. */
  votes?: Map<Address, bigint>;
  /** The vote of the other conduit `prepared` was checked after, if any. */
  rival?: Vote | undefined;
  /** The Klima conduit's: whether its vote answered a vote of the immutable conduit, rather than its votes in force. */
  answered?: boolean | undefined;
  summary: Record<string, unknown>;
};

/** One conduit's plans: `best` is the freshest that came back, and `recent` the last RECENT that did. */
export type Lane<P> = {
  name: string;
  plan: (best: P | undefined) => Promise<P>;
  best?: P | undefined;
  recent?: P[];
};

type Race<P> = {
  blocks: Blocks;
  lanes: Lane<P>[];
  /** Sends the lanes' plans for the block with timestamp `time` (ms). */
  send: (time: number) => void;
};

/** Keeps `plan` among the lane's recent ones, and makes it the lane's best if it is fresher. */
export function keep<P extends { readAt: number }>(lane: Lane<P>, plan: P): void {
  lane.recent = [...(lane.recent ?? []), plan].slice(-RECENT);
  if (!lane.best || plan.readAt > lane.best.readAt) lane.best = plan;
}

/**
 * Starts a plan of each lane every PLAN_EVERY_MS, and sends the lanes' plans at the deadline of each of the last two
 * blocks before `flip` (ms). Deadlines come from the block timing alone, so a poll or a plan that hangs delays nothing,
 * and lanes plan apart, so a lane that fails or lags delays no other. Returns the number of sends.
 */
export async function race<P extends { readAt: number }>(
  flip: number,
  { blocks, lanes, send }: Race<P>,
): Promise<number> {
  let done = false;
  const planning = async (lane: Lane<P>) => {
    let failure = "";
    let inFlight = 0;
    for (; !done; await sleep(PLAN_EVERY_MS)) {
      if (inFlight === MAX_PLANS) continue;
      inFlight++;
      void lane
        .plan(lane.best)
        .then(
          (p) => keep(lane, p),
          (error: unknown) => {
            const kind = errorKind(error);
            if (kind !== failure) log.warning("plan failed", { lane: lane.name, error: errorMessage(error) });
            failure = kind;
          },
        )
        .finally(() => inFlight--);
    }
  };
  let planned = false;
  let sends = 0;
  let after = -Infinity;
  for (;;) {
    const now = Date.now();
    const time = blocks.next(flip, after, now);
    if (time === undefined) {
      if (blocks.building(now) !== undefined || now >= flip) break;
      await sleep(TICK_MS);
      continue;
    }
    const { gap, lead } = blocks.timing;
    const deadline = time - lead;
    if (!planned && now >= deadline - 2 * gap) {
      planned = true;
      log.info("planning", { block: time / 1000, secondsToDeadline: (deadline - now) / 1000, ...blocks.timing });
      for (const lane of lanes) void planning(lane);
    }
    if (now < deadline) {
      await sleep(Math.min(deadline - now, TICK_MS));
      continue;
    }
    after = time;
    send(time);
    sends++;
  }
  done = true;
  return sends;
}

/**
 * The Klima conduit's water-filling vote, or null to keep the current one, against everyone else's votes: with the
 * immutable conduit's `v2Votes` on each pool instead of its votes in force, if given.
 */
function decide({ epoch, pools }: State, usd: number[], v2Votes?: Map<Address, bigint>) {
  const candidates = pools.map((p, i) => ({
    ...p,
    rewardsUsd: usd[i]!,
    otherVotes: p.otherVotes - p.v2Votes + (v2Votes ? (v2Votes.get(lower(p.pool)) ?? 0n) : p.v2Votes),
  }));
  const { fractions, vote } = select(candidates, epoch.power);
  const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
  return { vote, reason, summary: summarize(candidates, fractions, epoch.power) };
}

/**
 * The immutable conduit's votes the Klima conduit answers in the block at `time` (ms): those of its plan for that
 * block, if that plan has a vote ready to send. Otherwise the Klima conduit answers its votes in force.
 */
export function v2Answered(v2: Plan | undefined, time: number, dryRun: boolean): Map<Address, bigint> | undefined {
  const ready = v2?.prepared && v2.time === time && (v2.prepared.signed !== undefined || dryRun);
  return ready ? v2.votes : undefined;
}

/**
 * The nonces of the immutable conduit's sent votes that `state` shows in force. Anyone may vote for that conduit, so
 * its `lastVoted` does not tell whose vote landed, as the Klima conduit's does; but a vote in force with the same votes
 * on every pool as a sent one is that one, and its nonce is taken whatever a node behind says.
 */
export function landed(state: State, sent: Iterable<Sent>): number[] {
  if (!state.epoch.v2?.votedThisEpoch) return [];
  return [...sent].flatMap(({ votes, nonce }) =>
    votes && state.pools.every((p) => p.v2Votes === (votes.get(lower(p.pool)) ?? 0n)) ? [nonce] : [],
  );
}

/** The Klima conduit's vote prepared to send, which the immutable conduit's must clear after. */
const rivalOf = (klima: Plan | undefined): Vote | undefined => (klima?.prepared && klima.vote) || undefined;

/** The plans to send for each conduit: those that came back for the block, else the freshest. */
function forBlock(lane: Lane<Plan> | undefined, time: number): (Plan | undefined)[] {
  if (!lane?.best) return [undefined];
  const plans = (lane.recent ?? []).filter((p) => p.time === time);
  return plans.length ? plans : [lane.best];
}

/**
 * What each conduit sends in the block at `time` (ms). The immutable conduit's vote goes only with a Klima conduit's
 * vote it was checked after, so that it clears its check whichever lands first: of the plans for that block, the pair
 * whose staler plan is the freshest, among those in which at most one conduit votes or the immutable conduit's vote was
 * checked after the Klima conduit's. Without such a pair, the Klima conduit's alone, and `unchecked`: as the immutable
 * conduit's votes in force stay, its freshest plan that answered those, if any, else its `freshest`.
 */
export function pick(
  time: number,
  klima: Lane<Plan> | undefined,
  v2: Lane<Plan> | undefined,
): { klima?: Plan | undefined; v2?: Plan | undefined; unchecked?: true; freshest?: Plan | undefined } {
  const fresh = (p: Plan | undefined) => p?.readAt ?? Infinity;
  const checked = (k: Plan | undefined, v: Plan | undefined) => !k?.prepared || !v?.prepared || same(v.rival, k.vote);
  let best: { klima: Plan | undefined; v2: Plan | undefined; stale: number; freshest: number } | undefined;
  const klimas = forBlock(klima, time);
  for (const k of klimas) {
    for (const v of forBlock(v2, time)) {
      if (!checked(k, v)) continue;
      const [stale, freshest] = [Math.min(fresh(k), fresh(v)), Math.max(fresh(k), fresh(v))];
      if (!best || stale > best.stale || (stale === best.stale && freshest > best.freshest)) {
        best = { klima: k, v2: v, stale, freshest };
      }
    }
  }
  if (best) return { klima: best.klima, v2: best.v2 };
  const freshestOf = (plans: (Plan | undefined)[]) => plans.reduce((a, b) => (fresh(b) > fresh(a) ? b : a));
  const inForce = klimas.filter((k) => k && !k.answered);
  const freshest = freshestOf(klimas);
  return { klima: inForce.length ? freshestOf(inForce) : freshest, unchecked: true, freshest };
}

/**
 * The last value `read` gave, read again in the background once for each block, at its first call with that block's
 * `time`, and REREAD_MS after a read that fails; one read at a time. Only calls before any value wait for one, and for
 * `wait` ms at most: a read that hangs then holds back no plan.
 */
export function refreshed<T>(
  read: () => Promise<T>,
  unread: (error: unknown) => void,
  wait = FIRST_READ_WAIT_MS,
): (time: number) => Promise<{ value: T; version: number } | undefined> {
  let last: { value: T; version: number } | undefined;
  let reading: { time: number; done: Promise<void>; settled: boolean; failedAt?: number } | undefined;
  return async (time) => {
    const failedAt = reading?.failedAt;
    const due =
      !reading ||
      (reading.settled && (failedAt !== undefined ? Date.now() - failedAt >= REREAD_MS : reading.time !== time));
    if (due) {
      const entry: NonNullable<typeof reading> = { time, done: Promise.resolve(), settled: false };
      entry.done = read().then(
        (value) => {
          last = { value, version: (last?.version ?? 0) + 1 };
          entry.settled = true;
        },
        (error: unknown) => {
          entry.failedAt = Date.now();
          entry.settled = true;
          unread(error);
        },
      );
      reading = entry;
    }
    if (!last) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([reading!.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
      clearTimeout(timer);
    }
    return last;
  };
}

/** `decide` once for each key: plans that see the same votes decide alike. */
function memo<T>(): (key: string, decide: () => T) => T {
  let last: { key: string; value: T } | undefined;
  return (key, decide) => (last?.key === key ? last : (last = { key, value: decide() })).value;
}

/** What a conduit's decision depends on in a read of the votes. */
const keyOf = ({ epoch, pools }: State) =>
  [
    epoch.start,
    epoch.power,
    epoch.lastVoted,
    epoch.v2?.power,
    epoch.v2?.lastVoted,
    ...pools.flatMap((p) => [p.otherVotes, p.ownVotes, p.v2Votes]),
  ].join();

/**
 * Votes in each of the last two blocks before the flip, as late as each allows, for each conduit in `conduits`. Each
 * plans in its own lane, so that neither's failure or delay holds the other back. The Klima conduit's vote answers the
 * immutable conduit's vote prepared for the same block, and that one is sent only together with a Klima conduit's vote
 * it was checked after, so that it clears its check whichever lands first. Returns the number of failures.
 */
export async function lastBlocks(run: Run, flip: bigint, conduits: { klima: boolean; v2: boolean }): Promise<number> {
  const { chain, account, proposer, dryRun } = run;
  const flipMs = Number(flip) * 1000;
  // Prices fetched now are reused if every source fails during the warm-up.
  if (Date.now() < flipMs - WARMUP_MS) {
    await run
      .prices(tokensOf(run), flipMs - WARMUP_MS)
      .catch((error: unknown) => log.warning("prices not fetched ahead", { error: errorMessage(error) }));
  }
  await sleep(Math.max(0, flipMs - WARMUP_MS - Date.now()));
  log.info("last blocks", { flip, secondsToFlip: (flipMs - Date.now()) / 1000, ...conduits });
  const blocks = new Blocks();
  let watching = true;
  void watch(chain.client, blocks, () => !watching);
  let failures = 0;
  let rewards: PoolRewards[] = [];
  let priced: Prices = new Map();
  let usd: number[] = []; // each pool's rewards in USD, as `rewards`; votes do not change them
  let valued: Address[] = []; // the pools the immutable conduit can value

  /** Prepares a conduit's vote for the block at `base.time`, or reuses the one prepared for the same block and votes. */
  const prepare = async (
    base: Plan,
    best: Plan | undefined,
    lastVoted: bigint,
    sender: Sender,
    signer: LocalAccount | undefined,
    rival?: Rival,
  ): Promise<Plan> => {
    const { readAt, time, vote } = base;
    if (!vote) return base;
    if (Number(lastVoted) * 1000 >= time) return { ...base, note: "already voted in this block" };
    const reusable = best?.prepared && best.time === time && same(best.vote, vote) && same(best.rival, rival?.vote);
    if (reusable) return { ...best, readAt, answered: base.answered };
    const target = { time: BigInt(Math.floor(time / 1000)), lastVoted };
    const prepared = await prepareVote(chain, signer, vote, dryRun, target, sender, rival);
    return { ...base, prepared, rival: rival?.vote };
  };

  // Signatures of one transaction differ, so copies of it are found by its unsigned hash.
  const sent = new Map<Hex, Sent>();

  // The votes in the block being built, read once for the lanes that plan at about the same time. A plan is as fresh
  // as the read it uses, and for the block being built when that read started.
  let votes: { readAt: number; time: number; state: Promise<State> } | undefined;
  const votesNow = () => {
    const now = Date.now();
    if (!votes || now - votes.readAt >= SHARED_READ_MS) {
      votes = { readAt: now, time: blocks.building(now) ?? now, state: readVotes(chain, rewards, "pending") };
    }
    return votes;
  };

  // The immutable conduit's own values and score are read only for a vote it would send. Its values of pools barely
  // move, and reading them takes long, so plans use the last ones read, read again in the background once per block,
  // through the client for heavy reads; until the first comes, plans go without, and the simulation checks their votes.
  // Its score of the vote in force moves with every vote, so it is read with each such plan.
  const valuesNow = refreshed(
    () => readValues(chain, chain.bulk, valued, "pending"),
    warnOnce("v2's values unread; its simulation checks the vote"),
  );
  const scoreUnread = warnOnce("v2's score unread; its simulation checks the vote");
  const [decidedV2, onchainV2, decidedKlima] = [
    memo<ReturnType<typeof decideV2>>(),
    memo<ReturnType<typeof decideV2>>(),
    memo<ReturnType<typeof decide>>(),
  ];

  const v2Lane: Lane<Plan> = {
    name: "v2",
    plan: async (best) => {
      const { readAt, time, state: reading } = votesNow();
      const state = await reading;
      assertFresh(state.epoch);
      for (const nonce of landed(state, sent.values())) markMined(chain, nonce, v2Sender(chain).from);
      const key = keyOf(state);
      let decision = decidedV2(key, () => decideV2(state, usd, undefined));
      if (decision.vote) {
        const [values, current] = await Promise.all([
          valuesNow(time),
          readScore(chain, chain.v2Client, "pending").catch(scoreUnread),
        ]);
        if (values && current !== undefined) {
          const onchain = { values: values.value, current };
          decision = onchainV2(`${key}|${values.version}|${current}`, () => decideV2(state, usd, onchain));
        }
      }
      const { vote, note, summary, votes } = decision;
      const byPool = new Map(state.pools.map((p, i) => [lower(p.pool), votes[i]!]));
      const base = { readAt, time, vote, note, summary, votes: byPool };
      const klimaVote = rivalOf(klimaLane.best);
      const rival = klimaVote && { sender: klimaSender(chain), vote: klimaVote };
      return prepare(base, best, state.epoch.v2?.lastVoted ?? 0n, v2Sender(chain), proposer, rival);
    },
  };

  const klimaLane: Lane<Plan> = {
    name: "klima",
    plan: async (best) => {
      const { readAt, time, state: reading } = votesNow();
      const state = await reading;
      assertFresh(state.epoch);
      const answered = conduits.v2 ? v2Answered(v2Lane.best, time, dryRun) : undefined;
      const key = `${keyOf(state)}|${answered ? [...answered].join() : "-"}`;
      const { vote, reason, summary } = decidedKlima(key, () => decide(state, usd, answered));
      const base = { readAt, time, vote, note: reason, summary, answered: answered !== undefined };
      return prepare(base, best, state.epoch.lastVoted, klimaSender(chain), account);
    },
  };

  const lanes = [...(conduits.v2 ? [v2Lane] : []), ...(conduits.klima ? [klimaLane] : [])];
  if (lanes.length === 0) {
    watching = false;
    return 0;
  }

  // What every lane needs, read once: the block timing, the rewards and their value.
  for (;;) {
    try {
      const { number, timestamp } = await chain.client.getBlock();
      blocks.observe({ number, timestamp, txs: 0 }, Date.now());
      rewards = await readRewards(chain, tokensOf(run));
      priced = await run.prices(tokensOf(run), flipMs - PRICES_BY_MS);
      // Prices that value no reward fail here, and are fetched again.
      usd = valueRewards(run, rewards, priced, false);
      valued = chain.v2 ? pricedPools(rewards, chain.v2.priced) : [];
      break;
    } catch (error) {
      const retry = Date.now() + RETRY_DELAY_MS < flipMs - PRICES_BY_MS;
      log.error(`last blocks: warm-up failed${retry ? ", retrying" : ""}`, { error: errorMessage(error) });
      if (!retry) {
        watching = false;
        return 1;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  // Each pool, with its votes as the first plans read them. A read that fails fails those plans, which log it.
  const { state: first } = votesNow();
  void first.then(({ pools }) => valueRewards(run, pools, priced, true)).catch(() => undefined);
  // Each lane's first plan, tried until one comes back, while the race starts: it is sent if no later one is.
  void Promise.all(
    lanes.map(async (lane) => {
      while (!lane.best && Date.now() + RETRY_DELAY_MS < flipMs - PRICES_BY_MS) {
        try {
          keep(lane, await lane.plan(undefined));
        } catch (error) {
          log.error("last blocks: first plan failed, retrying", { lane: lane.name, error: errorMessage(error) });
          await sleep(RETRY_DELAY_MS);
        }
      }
    }),
  );

  const sending: Promise<void>[] = [];
  const sendOne = (plan: Plan | undefined, sender: Sender, at: Record<string, unknown>) => {
    const { conduit } = sender;
    if (!plan) {
      failures++;
      return log.error("nothing planned in time", { conduit, ...at });
    }
    const fields = { conduit, ...at, ageMs: Date.now() - plan.readAt, ...plan.summary };
    const { prepared } = plan;
    if (!prepared) return log.info(plan.note, fields);
    const { tx, signed } = prepared;
    if (!signed) return log.info("not signed, not sent", fields);
    if (dryRun) return log.info("dry run: signed, not sent", fields);
    const id = keccak256(serializeTransaction(tx));
    if (sent.has(id)) return log.info("already sent", { conduit, ...at });
    sent.set(id, { hash: keccak256(signed), vote: plan.vote!, nonce: tx.nonce, sender, votes: plan.votes });
    log.info("voting", { ...fields, nonce: tx.nonce, tip: tx.maxPriorityFeePerGas });
    sending.push(
      broadcastTx(chain, { ...prepared, signed }, flipMs).then(
        (hash) => log.info("vote sent", { conduit, hash }),
        async (error: unknown) => {
          const notSent = { conduit, nonce: tx.nonce, error: errorMessage(error) };
          if (await nonceTaken(chain, tx.nonce, sender.from)) {
            return log.warning("vote not sent: an earlier vote took its nonce", notSent);
          }
          failures++;
          log.error("vote not sent", notSent);
        },
      ),
    );
  };
  // The immutable conduit's first, so that, at equal tips, its vote reaches the builder first.
  const send = (time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    const picked = pick(time, conduits.klima ? klimaLane : undefined, conduits.v2 ? v2Lane : undefined);
    if (picked.unchecked) {
      const { klima: alone, freshest } = picked;
      const ageMs = (plan: Plan | undefined) => plan && Date.now() - plan.readAt;
      log.warning("not voting for v2 in this block: no vote of it was checked after the Klima conduit's", {
        conduit: chain.v2?.conduit,
        ...at,
        // The Klima conduit sends a staler plan than its freshest, which answered a vote not sent.
        ...(alone !== freshest ? { klimaAgeMs: ageMs(alone), freshestKlimaAgeMs: ageMs(freshest) } : {}),
      });
    } else if (conduits.v2) sendOne(picked.v2, v2Sender(chain), at);
    if (conduits.klima) sendOne(picked.klima, klimaSender(chain), at);
  };

  const sends = await race(flipMs, { blocks, lanes, send });
  watching = false;
  if (sends === 0) {
    failures++;
    log.error("no block left to vote in before the flip");
  }
  await Promise.all(sending);
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  const voters = [...(conduits.v2 ? [chain.v2!.conduit] : []), ...(conduits.klima ? [chain.conduit] : [])];
  return failures + (await outcome(run, flip, [...sent.values()], voters));
}

/**
 * Logs where each sent vote landed, checks the last one of each conduit before the flip, and that the Voter shows a
 * vote of each of `conduits` in the epoch that ends at `flip`. Returns the number of failures.
 */
export async function outcome(
  { chain, dryRun }: Run,
  flip: bigint,
  sent: Sent[],
  conduits: Address[],
): Promise<number> {
  let failures = 0;
  const last = new Map<Address, { hash: Hex; vote: Vote; block: bigint; timestamp: bigint }>();
  for (const { hash, vote, nonce, sender } of sent) {
    const conduit = lower(sender.conduit);
    try {
      const receipt = await chain.client.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      });
      if (!receipt) {
        log.info("vote not mined: replaced or dropped", { conduit, hash });
        continue;
      }
      markMined(chain, nonce, sender.from); // so that the claims after the flip do not reuse its nonce
      const block = receipt.blockNumber;
      const fields = { conduit, hash, block, status: receipt.status };
      const { timestamp } = await chain.client.getBlock({ blockNumber: block });
      if (timestamp >= flip) log.warning("vote landed after the flip", fields);
      else if (receipt.status !== "success") {
        // Anyone may vote for an open conduit, and the Voter takes one vote of it per block.
        if (sender.open && (await lastVotedAt(chain, conduit, block)) === timestamp) {
          log.warning("vote reverted: another vote for the conduit was first in its block", fields);
        } else {
          failures++;
          log.error("vote reverted", fields);
        }
      } else if (block > (last.get(conduit)?.block ?? -1n)) last.set(conduit, { hash, vote, block, timestamp });
    } catch (error) {
      failures++;
      log.error("vote outcome unknown", { conduit, hash, error: errorMessage(error) });
    }
  }
  for (const [conduit, { vote, hash, block }] of last) {
    await verifyVote(chain, vote, hash, block, conduit).catch((error: unknown) => {
      failures++;
      log.error("vote not confirmed", { conduit, error: errorMessage(error) });
    });
  }
  // As of the last block before the flip: anyone may vote for the immutable conduit in the next epoch already.
  const lastVotedBefore = async () => {
    const before = await lastBlockBefore(chain.client, flip);
    const calls = conduits.map((conduit) => voterCall(chain, "lastVoted", [conduit]));
    return readMany<bigint>(chain.client, calls, { blockNumber: before });
  };
  let lastVoted: bigint[] | undefined;
  for (let attempt = 1; !lastVoted; attempt++) {
    try {
      lastVoted = await lastVotedBefore();
    } catch (error) {
      const fields = { attempt, error: errorMessage(error) };
      if (attempt === OUTCOME_TRIES) {
        // Whether each conduit voted this epoch is unknown.
        (dryRun ? log.warning : log.error)("lastVoted unread", fields);
        return failures + (dryRun ? 0 : 1);
      }
      log.warning("lastVoted unread, retrying", fields);
      await sleep(OUTCOME_RETRY_MS);
    }
  }
  conduits.forEach((conduit, i) => {
    const fields = { conduit, lastVoted: lastVoted[i]! };
    if (fields.lastVoted < flip - WEEK) {
      if (dryRun) return log.warning("no vote this epoch", fields);
      failures++;
      return log.error("no vote this epoch", fields);
    }
    log.info("voted this epoch", fields);
    const ours = last.get(lower(conduit));
    if (ours && fields.lastVoted > ours.timestamp) log.warning("another vote replaced the last one sent", fields);
  });
  return failures;
}

const same = (a: Vote | null | undefined, b: Vote | null | undefined) =>
  a === b || (!!a && !!b && a.pools.join() === b.pools.join() && a.weights.join() === b.weights.join());

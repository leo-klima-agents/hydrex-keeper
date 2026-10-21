import {
  keccak256,
  serializeTransaction,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { Blocks, sleep, watch } from "./blocks.ts";
import { lower, readMany, voterCall, WEEK, type Chain, type Client } from "./chain.ts";
import { decideV2, pricedPools, readScore, readValues } from "./immutable.ts";
import { errorMessage, log } from "./log.ts";
import type { Prices } from "./prices.ts";
import { tokensOf, valueRewards, type Run } from "./pass.ts";
import { assertFresh, readRewards, readVotes, type PoolRewards, type State } from "./read.ts";
import { select, summarize, type Vote } from "./select.ts";
import {
  broadcastTx,
  klimaSender,
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
const RETRY_DELAY_MS = 5_000;
const SETTLE_MS = 10_000; // after the flip, so that lagging RPCs have the last blocks
const BLOCK_SECONDS = 2n; // on Base

type Sent = { hash: Hex; vote: Vote; nonce: number; sender: Sender };

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
  summary: Record<string, unknown>;
};

/** One conduit's plans: `best` is the freshest that came back. */
export type Lane<P> = { name: string; plan: (best: P | undefined) => Promise<P>; best?: P | undefined };

type Race<P> = {
  blocks: Blocks;
  lanes: Lane<P>[];
  send: (bests: (P | undefined)[], time: number) => void;
};

/** Makes `plan` the lane's best if it is fresher. */
export function keep<P extends { readAt: number }>(lane: Lane<P>, plan: P): void {
  if (!lane.best || plan.readAt > lane.best.readAt) lane.best = plan;
}

/**
 * Starts a plan of each lane every PLAN_EVERY_MS, and sends the freshest plan of each at the deadline of each of the
 * last two blocks before `flip` (ms). Deadlines come from the block timing alone, so a poll or a plan that hangs delays
 * nothing, and lanes plan apart, so a lane that fails or lags delays no other. Returns the number of sends.
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
            const message = errorMessage(error);
            if (message !== failure) log.warning("plan failed", { lane: lane.name, error: (failure = message) });
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
    send(
      lanes.map((lane) => lane.best),
      time,
    );
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

/** The Klima conduit's vote prepared for the block at `time` (ms), which the immutable conduit's must clear after. */
function rivalOf(klima: Plan | undefined, time: number): Vote | undefined {
  return klima?.prepared && klima.time === time && klima.vote ? klima.vote : undefined;
}

/**
 * Votes in each of the last two blocks before the flip, as late as each allows, for each conduit in `conduits`. Each
 * plans in its own lane, so that neither's failure or delay holds the other back. The Klima conduit's vote answers the
 * immutable conduit's vote prepared for the same block, and that one is sent only if it clears its conduit's check
 * whether or not the Klima conduit's lands first. Returns the number of failures.
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
  let valued: Address[] = []; // the pools the immutable conduit can value
  let verbose = true; // the first plan logs each pool
  const valueOnce = (state: State) => {
    const usd = valueRewards(run, state.pools, priced, verbose);
    verbose = false;
    return usd;
  };

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
    if (reusable) return { ...best, readAt };
    const target = { time: BigInt(Math.floor(time / 1000)), lastVoted };
    const prepared = await prepareVote(chain, signer, vote, dryRun, target, sender, rival);
    return { ...base, prepared, rival: rival?.vote };
  };

  // The immutable conduit's values of pools barely move within a block, and cost far more gas than votes, so they are
  // read once per block; a read that fails is tried again by the next plan. Its score of the vote in force moves with
  // every vote, so it is read with each plan.
  let values: { time: number; read: Promise<Map<Address, number>> } | undefined;
  let unreadSince = "";
  const unread = (error: unknown) => {
    const message = errorMessage(error);
    if (message !== unreadSince) log.warning("v2's own values unread", { error: (unreadSince = message) });
    return undefined;
  };
  const valuesAt = (time: number) => {
    if (values?.time !== time) {
      const read = readValues(chain, chain.client, valued, "pending");
      values = { time, read };
      read.catch(() => {
        if (values?.read === read) values = undefined;
      });
    }
    return values.read.catch(unread);
  };

  const v2Lane: Lane<Plan> = {
    name: "v2",
    plan: async (best) => {
      const readAt = Date.now();
      const time = blocks.building(readAt) ?? readAt;
      const [state, poolValues, current] = await Promise.all([
        readVotes(chain, rewards, "pending"),
        valuesAt(time),
        readScore(chain, chain.client, "pending").catch(unread),
      ]);
      assertFresh(state.epoch);
      const onchain = poolValues && current !== undefined ? { values: poolValues, current } : undefined;
      const { vote, note, summary, votes } = decideV2(state, valueOnce(state), onchain);
      const byPool = new Map(state.pools.map((p, i) => [lower(p.pool), votes[i]!]));
      const base = { readAt, time, vote, note, summary, votes: byPool };
      const klimaVote = rivalOf(klimaLane.best, time);
      const rival = klimaVote && { sender: klimaSender(chain), vote: klimaVote };
      return prepare(base, best, state.epoch.v2?.lastVoted ?? 0n, v2Sender(chain), proposer, rival);
    },
  };

  const klimaLane: Lane<Plan> = {
    name: "klima",
    plan: async (best) => {
      const readAt = Date.now();
      const time = blocks.building(readAt) ?? readAt;
      const state = await readVotes(chain, rewards, "pending");
      assertFresh(state.epoch);
      const answered = conduits.v2 ? v2Answered(v2Lane.best, time, dryRun) : undefined;
      const { vote, reason, summary } = decide(state, valueOnce(state), answered);
      const base = { readAt, time, vote, note: reason, summary };
      return prepare(base, best, state.epoch.lastVoted, klimaSender(chain), account);
    },
  };

  // The immutable conduit's first, so that, at equal tips, its vote reaches the builder first.
  const lanes = [
    ...(conduits.v2 ? [{ lane: v2Lane, sender: v2Sender(chain) }] : []),
    ...(conduits.klima ? [{ lane: klimaLane, sender: klimaSender(chain) }] : []),
  ];
  if (lanes.length === 0) {
    watching = false;
    return 0;
  }

  // What every lane needs, read once: the block timing, the rewards and their prices.
  for (;;) {
    try {
      const { number, timestamp } = await chain.client.getBlock();
      blocks.observe({ number, timestamp, txs: 0 }, Date.now());
      rewards = await readRewards(chain, tokensOf(run));
      priced = await run.prices(tokensOf(run), flipMs - PRICES_BY_MS);
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
  // Each lane's first plan, tried until one comes back, while the race starts: it is sent if no later one is.
  void Promise.all(
    lanes.map(async ({ lane }) => {
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

  // Signatures of one transaction differ, so copies of it are found by its unsigned hash.
  const sent = new Map<Hex, Sent>();
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
    sent.set(id, { hash: keccak256(signed), vote: plan.vote!, nonce: tx.nonce, sender });
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
  const send = (bests: (Plan | undefined)[], time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    lanes.forEach(({ sender }, i) => sendOne(bests[i], sender, at));
  };

  const sends = await race(flipMs, { blocks, lanes: lanes.map(({ lane }) => lane), send });
  watching = false;
  if (sends === 0) {
    failures++;
    log.error("no block left to vote in before the flip");
  }
  await Promise.all(sending);
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  const voters = lanes.map(({ sender }) => sender.conduit);
  return failures + (await outcome(run, flip, [...sent.values()], voters));
}

/** The number of the last block before `time` (s): estimated from the latest block, then checked. */
export async function lastBlockBefore(client: Client, time: bigint): Promise<bigint> {
  const head = await client.getBlock();
  let number = head.number - (head.timestamp - time) / BLOCK_SECONDS - 1n;
  for (let step = 0; step < 20; step++) {
    const [block, next] = await Promise.all([
      client.getBlock({ blockNumber: number }),
      client.getBlock({ blockNumber: number + 1n }),
    ]);
    if (block.timestamp >= time) number--;
    else if (next.timestamp < time) number++;
    else return number;
  }
  throw new Error(`no block found just before ${time}`);
}

/** When the Voter last recorded a vote of `conduit`, as of block `blockNumber`. */
async function lastVotedAt(chain: Chain, conduit: Address, blockNumber: bigint): Promise<bigint> {
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [conduit])], { blockNumber });
  return lastVoted!;
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
  try {
    // As of the last block before the flip: anyone may vote for the immutable conduit in the next epoch already.
    const before = await lastBlockBefore(chain.client, flip);
    const lastVoted = await readMany<bigint>(
      chain.client,
      conduits.map((conduit) => voterCall(chain, "lastVoted", [conduit])),
      { blockNumber: before },
    );
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
  } catch (error) {
    log.warning("lastVoted unread", { error: errorMessage(error) });
  }
  return failures;
}

const same = (a: Vote | null | undefined, b: Vote | null | undefined) =>
  a === b || (!!a && !!b && a.pools.join() === b.pools.join() && a.weights.join() === b.weights.join());

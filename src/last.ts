import { setTimeout as sleep } from "node:timers/promises";
import { keccak256, type Hex } from "viem";
import { Blocks, watch } from "./blocks.ts";
import { errorMessage, log } from "./log.ts";
import type { Prices } from "./prices.ts";
import { decide, nameOf, readState, tokensOf, type Run, type State } from "./pass.ts";
import type { Vote } from "./select.ts";
import { broadcastVote, prepareVote, verifyVote, type Prepared } from "./vote.ts";

export const WARMUP_MS = 60_000; // the pass starts this long before the flip, to learn the block timing
const PRICES_BY_MS = 5_000; // before the flip
const TICK_MS = 50;
const PLAN_EVERY_MS = 100;
const MAX_PLANS = 3; // in flight
const RETRY_DELAY_MS = 5_000;
const SETTLE_MS = 4_000; // after the flip, before reading the outcome

/** What to send in the block with timestamp `time` (ms), from a read at `readAt` (ms). */
export type Plan = {
  readAt: number;
  time: number;
  vote: Vote | null;
  note: string;
  prepared?: Prepared;
  summary: Record<string, unknown>;
};

type Race = {
  blocks: Blocks;
  plan: (best: Plan | undefined) => Promise<Plan>;
  send: (best: Plan | undefined, time: number) => void;
};

/**
 * Starts a plan every PLAN_EVERY_MS, and sends the freshest plan at the deadline of each of the last two blocks before
 * `flip` (ms). Deadlines come from the block timing alone, so a poll or a plan that hangs delays nothing. Returns the
 * number of sends.
 */
export async function race(flip: number, { blocks, plan, send }: Race, first?: Plan): Promise<number> {
  let best = first;
  let done = false;
  let failure = "";
  let inFlight = 0;
  const planning = async () => {
    for (; !done; await sleep(PLAN_EVERY_MS)) {
      if (inFlight === MAX_PLANS) continue;
      inFlight++;
      void plan(best)
        .then(
          (p) => {
            if (!best || p.readAt > best.readAt) best = p;
          },
          (error: unknown) => {
            if (errorMessage(error) !== failure) log.warning("plan failed", { error: (failure = errorMessage(error)) });
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
    const { gap, seal, lead } = blocks.timing;
    const deadline = time - lead;
    if (!planned && now >= deadline - 2 * gap) {
      planned = true;
      log.info("planning", { block: time / 1000, secondsToDeadline: (deadline - now) / 1000, ...blocks.timing });
      void planning();
    }
    if (now < deadline) {
      await sleep(Math.min(deadline - now, TICK_MS));
      continue;
    }
    after = time;
    if (now >= time + seal) {
      log.warning("missed the block", { block: time / 1000, deadline, seal: time + seal });
      continue;
    }
    send(best, time);
    sends++;
  }
  done = true;
  return sends;
}

/** Votes in each of the last two blocks before the flip, as late as each allows. Returns the number of failures. */
export async function lastBlocks(run: Run, flip: bigint): Promise<number> {
  const { chain, account, dryRun } = run;
  const flipMs = Number(flip) * 1000;
  await sleep(Math.max(0, flipMs - WARMUP_MS - Date.now()));
  log.info("last blocks", { flip, secondsToFlip: (flipMs - Date.now()) / 1000 });
  const blocks = new Blocks();
  let watching = true;
  void watch(chain.client, blocks, () => !watching);
  let failures = 0;
  let priced: Prices = new Map();
  let latest: { readAt: number; state: State } | undefined;

  const plan = async (best: Plan | undefined, verbose = false): Promise<Plan> => {
    const readAt = Date.now();
    const time = blocks.building(readAt) ?? readAt;
    const state = await readState(run, "pending");
    if (!latest || readAt > latest.readAt) {
      const before = new Map(latest?.state.rewards.map((p) => [p.pool, p.otherVotes]));
      const moved = state.rewards.flatMap((p) => {
        const was = before.get(p.pool);
        return was === undefined || was === p.otherVotes
          ? []
          : [{ pool: nameOf(run, p.pool), change: p.otherVotes - was }];
      });
      if (moved.length) log.info("others voted", { block: time / 1000, pools: moved });
      latest = { readAt, state };
    }
    const { vote, reason, summary } = decide(run, state, priced, verbose);
    const base = { readAt, time, vote, note: reason, summary };
    if (!vote) return base;
    if (Number(state.epoch.lastVoted) * 1000 >= time) return { ...base, note: "already voted in this block" };
    if (best?.prepared && best.time === time && same(best.vote, vote)) return { ...best, readAt };
    return { ...base, prepared: await prepareVote(chain, account, vote, dryRun, BigInt(Math.floor(time / 1000))) };
  };

  let first: Plan | undefined;
  while (!first) {
    try {
      const { number, timestamp } = await chain.client.getBlock();
      blocks.observe({ number, timestamp, txs: 0 }, Date.now());
      const state = await readState(run);
      priced = await run.prices(tokensOf(state), flipMs - PRICES_BY_MS);
      first = await plan(undefined, true);
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

  const sent = new Map<Hex, Vote>();
  const sending: Promise<void>[] = [];
  const send = (best: Plan | undefined, time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    if (!best) {
      failures++;
      log.error("nothing planned in time", at);
      return;
    }
    const fields = { ...at, ageMs: Date.now() - best.readAt, ...best.summary };
    const { tx, signed } = best.prepared ?? {};
    if (!tx) return log.info(best.note, fields);
    if (!signed) return log.info("not signed, not sent", fields);
    if (dryRun) return log.info("dry run: signed, not sent", fields);
    const hash = keccak256(signed);
    if (sent.has(hash)) return log.info("already sent", { ...at, hash });
    sent.set(hash, best.vote!);
    log.info("voting", { ...fields, nonce: tx.nonce, tip: tx.maxPriorityFeePerGas });
    sending.push(
      broadcastVote(chain, { tx, signed }, flipMs).then(
        (hash) => log.info("vote sent", { hash }),
        (error: unknown) => {
          failures++;
          log.error("vote not sent", { error: errorMessage(error) });
        },
      ),
    );
  };

  const sends = await race(flipMs, { blocks, plan, send }, first);
  watching = false;
  if (sends === 0) {
    failures++;
    log.error("no block left to vote in before the flip");
  }
  await Promise.all(sending);
  if (sent.size === 0) return failures;
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  return failures + (await outcome(run, flip, sent));
}

/** Logs where each sent vote landed and checks the last one before the flip. Returns the number of failures. */
async function outcome({ chain }: Run, flip: bigint, sent: Map<Hex, Vote>): Promise<number> {
  let failures = 0;
  let last: { hash: Hex; vote: Vote; block: bigint } | undefined;
  for (const [hash, vote] of sent) {
    try {
      const receipt = await chain.client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (!receipt) {
        log.info("vote not mined: replaced or dropped", { hash });
        continue;
      }
      const fields = { hash, block: receipt.blockNumber, status: receipt.status };
      const { timestamp } = await chain.client.getBlock({ blockNumber: receipt.blockNumber });
      if (timestamp >= flip) log.warning("vote landed after the flip", fields);
      else if (receipt.status !== "success") {
        failures++;
        log.error("vote reverted", fields);
      } else if (!last || receipt.blockNumber > last.block) last = { hash, vote, block: receipt.blockNumber };
    } catch (error) {
      failures++;
      log.error("vote outcome unknown", { hash, error: errorMessage(error) });
    }
  }
  if (last) {
    await verifyVote(chain, last.vote, last.hash, last.block).catch((error: unknown) => {
      failures++;
      log.error("vote not confirmed", { error: errorMessage(error) });
    });
  }
  return failures;
}

const same = (a: Vote | null, b: Vote) =>
  a !== null && a.pools.join() === b.pools.join() && a.weights.join() === b.weights.join();

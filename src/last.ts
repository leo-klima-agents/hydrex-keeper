import { keccak256, serializeTransaction, TransactionReceiptNotFoundError, type Hex } from "viem";
import { Blocks, sleep, watch } from "./blocks.ts";
import { readMany, voterCall, WEEK } from "./chain.ts";
import { errorMessage, log } from "./log.ts";
import type { Prices } from "./prices.ts";
import { decide, readState, type Run } from "./pass.ts";
import type { Layout } from "./read.ts";
import type { Vote } from "./select.ts";
import { broadcastVote, prepareVote, verifyVote, type Prepared } from "./vote.ts";

export const WARMUP_MS = 60_000; // the pass starts this long before the flip, to learn the block timing
const PRICES_BY_MS = 5_000; // before the flip
const TICK_MS = 50;
const PLAN_EVERY_MS = 100;
const MAX_PLANS = 3; // in flight
const RETRY_DELAY_MS = 5_000;
const SETTLE_MS = 10_000; // after the flip, so that lagging RPCs have the last blocks

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
    const { gap, lead } = blocks.timing;
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
  let priced: Prices = new Map();
  let pricedFor: Layout | undefined;
  // Every reward token of the layout, so that a bribe funded late in any of them counts.
  const reprice = async (until: number) => {
    pricedFor = run.layout;
    const tokens = run.layout!.slots.map((s) => s.token);
    priced = await run.prices(tokens, until);
  };
  // Prices fetched now are reused if every source fails during the warm-up.
  if (Date.now() < flipMs - WARMUP_MS) {
    await readState(run)
      .then(() => reprice(flipMs - WARMUP_MS))
      .catch((error: unknown) => log.warning("prices not fetched ahead", { error: errorMessage(error) }));
  }
  await sleep(Math.max(0, flipMs - WARMUP_MS - Date.now()));
  log.info("last blocks", { flip, secondsToFlip: (flipMs - Date.now()) / 1000 });
  const blocks = new Blocks();
  let watching = true;
  void watch(chain.client, blocks, () => !watching);
  let failures = 0;

  const plan = async (best: Plan | undefined, verbose = false): Promise<Plan> => {
    const readAt = Date.now();
    const time = blocks.building(readAt) ?? readAt;
    const state = await readState(run, "pending");
    if (run.layout !== pricedFor) {
      void reprice(flipMs).catch((error: unknown) =>
        log.warning("new reward tokens not priced", { error: errorMessage(error) }),
      );
    }
    const { vote, reason, summary } = decide(run, state, priced, verbose);
    const base = { readAt, time, vote, note: reason, summary };
    if (!vote) return base;
    if (Number(state.epoch.lastVoted) * 1000 >= time) return { ...base, note: "already voted in this block" };
    if (best?.prepared && best.time === time && same(best.vote, vote)) return { ...best, readAt };
    const target = { time: BigInt(Math.floor(time / 1000)), lastVoted: state.epoch.lastVoted };
    return { ...base, prepared: await prepareVote(chain, account, vote, dryRun, target) };
  };

  let first: Plan | undefined;
  while (!first) {
    try {
      const { number, timestamp } = await chain.client.getBlock();
      blocks.observe({ number, timestamp, txs: 0 }, Date.now());
      await readState(run);
      await reprice(flipMs - PRICES_BY_MS);
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

  // Signatures of one transaction differ, so copies of it are found by its unsigned hash.
  const sent = new Map<Hex, { hash: Hex; vote: Vote }>();
  const sending: Promise<void>[] = [];
  const send = (best: Plan | undefined, time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    if (!best) {
      failures++;
      log.error("nothing planned in time", at);
      return;
    }
    const fields = { ...at, ageMs: Date.now() - best.readAt, ...best.summary };
    const { prepared } = best;
    if (!prepared) return log.info(best.note, fields);
    const { tx, signed } = prepared;
    if (!signed) return log.info("not signed, not sent", fields);
    if (dryRun) return log.info("dry run: signed, not sent", fields);
    const id = keccak256(serializeTransaction(tx));
    if (sent.has(id)) return log.info("already sent", at);
    sent.set(id, { hash: keccak256(signed), vote: best.vote! });
    log.info("voting", { ...fields, nonce: tx.nonce, tip: tx.maxPriorityFeePerGas });
    sending.push(
      broadcastVote(chain, { ...prepared, signed }, flipMs).then(
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
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  return failures + (await outcome(run, flip, [...sent.values()]));
}

/**
 * Logs where each sent vote landed, checks the last one before the flip, and that the Voter shows a vote this epoch.
 * Returns the number of failures.
 */
async function outcome({ chain, dryRun }: Run, flip: bigint, sent: { hash: Hex; vote: Vote }[]): Promise<number> {
  let failures = 0;
  let last: { hash: Hex; vote: Vote; block: bigint } | undefined;
  for (const { hash, vote } of sent) {
    try {
      const receipt = await chain.client.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      });
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
  try {
    const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [chain.conduit])]);
    if (lastVoted! >= flip - WEEK && lastVoted! < flip) log.info("voted this epoch", { lastVoted });
    else if (dryRun) log.warning("no vote this epoch", { lastVoted });
    else {
      failures++;
      log.error("no vote this epoch", { lastVoted });
    }
  } catch (error) {
    log.warning("lastVoted unread", { error: errorMessage(error) });
  }
  return failures;
}

const same = (a: Vote | null, b: Vote) =>
  a !== null && a.pools.join() === b.pools.join() && a.weights.join() === b.weights.join();

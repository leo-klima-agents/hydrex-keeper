import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage, log } from "./log.ts";
import { GRACE_MS, lastBlocksStart, type Head, type Schedule } from "./schedule.ts";
import { VoteSent, type Sent } from "./vote.ts";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

export type Io = {
  pass: (until: number) => Promise<Sent | undefined>;
  confirm: (sent: Sent, until: number) => Promise<void>;
  blocks: () => AsyncIterable<Head>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Runs the schedule: each timed pass, given until the next one or until the last blocks start, then a pass when the
 * last blocks start and one on each of them, confirming only the last vote sent. Returns the number of failures.
 */
export async function runPasses(plan: Schedule, flip: bigint, interval: number, io: Io): Promise<number> {
  const now = io.now ?? Date.now;
  const wait = io.sleep ?? ((ms: number) => sleep(ms));
  const toFlip = () => flip - BigInt(Math.floor(now() / 1000));
  const start = plan.last ? lastBlocksStart(flip, interval) : Infinity;
  let failed = 0;

  for (const [i, time] of plan.times.entries()) {
    await wait(Math.max(0, Number(time) * 1000 - now()));
    const until = Math.min(i + 1 < plan.times.length ? Number(plan.times[i + 1]!) * 1000 : Infinity, start);
    if (now() >= until) {
      log.warning("pass skipped, overdue", { at: time, secondsToFlip: toFlip() });
      continue;
    }
    log.info("pass", { at: time, flip, secondsToFlip: toFlip() });
    for (let attempt = 1; ; attempt++) {
      const started = now();
      try {
        const sent = await io.pass(until);
        if (sent) await io.confirm(sent, until);
        log.info("pass done", { ms: now() - started, secondsToFlip: toFlip() });
        break;
      } catch (error) {
        const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && now() + RETRY_DELAY_MS < until;
        log.error(`pass failed${retry ? ", retrying" : ""}`, {
          attempt,
          ms: now() - started,
          error: errorMessage(error),
        });
        if (!retry) {
          failed++;
          break;
        }
        await wait(RETRY_DELAY_MS);
      }
    }
  }
  if (!plan.last) return failed;

  const until = Number(flip) * 1000 + GRACE_MS;
  let sent: Sent | undefined;
  let ok = true;
  const attempt = async (fields: Record<string, unknown>) => {
    const started = now();
    log.info("pass", { ...fields, flip, secondsToFlip: toFlip() });
    try {
      sent = (await io.pass(until)) ?? sent;
      log.info("pass done", { ms: now() - started, secondsToFlip: toFlip() });
      ok = true;
    } catch (error) {
      const failure = { ms: now() - started, error: errorMessage(error) };
      if (toFlip() <= 0n) {
        log.warning("pass failed after the flip", failure);
      } else {
        ok = false;
        log.error("pass failed", failure);
      }
    }
  };
  await wait(Math.max(0, start - now()));
  await attempt({ interval });
  let blocks = 0;
  for await (const head of io.blocks()) {
    blocks++;
    await attempt({ block: head.number, timestamp: head.timestamp });
  }
  if (!blocks) {
    log.error("no block seen in the last window");
    ok = false;
  }
  if (sent) {
    try {
      await io.confirm(sent, until);
    } catch (error) {
      log.error("last vote failed", { error: errorMessage(error) });
      ok = false;
    }
  }
  return failed + (ok ? 0 : 1);
}

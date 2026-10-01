import { setTimeout as sleep } from "node:timers/promises";
import { BLOCK_TIME, type Block } from "./chain.ts";
import { errorMessage, log } from "./log.ts";
import type { Schedule } from "./schedule.ts";
import { VoteSent } from "./vote.ts";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
// A pass on every block waits this long for its receipt: a vote sent after block T is mined at T+2 or T+4. Longer
// would stall the loop behind a stuck vote; shorter would replace a vote about to be mined.
const PASS_BUDGET_MS = 5_000;

/** What a pass did: voted (or signed, in a dry run), left a vote pending, kept the current one, or could not send. */
export type Outcome = "voted" | "pending" | "kept" | "skipped";

export type Io = {
  nextBlock: (after: bigint, mintedAt: bigint, until: number) => Promise<Block | undefined>;
  pass: (block: Block, until: number) => Promise<Outcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Runs the plan: each pass on the first block minted at or after its time, with the time until the next one, then
 * one on every block up to the last one before the flip. Returns the number of failures.
 */
export async function runPasses(plan: Schedule, flip: bigint, io: Io): Promise<number> {
  const now = io.now ?? Date.now;
  const wait = io.sleep ?? ((ms: number) => sleep(ms));
  const ms = (seconds: bigint) => Number(seconds) * 1000;
  let after = 0n; // the last block passed, so that a lagging node cannot serve an older one
  let failed = 0;

  for (const [i, time] of plan.times.entries()) {
    const next = plan.times[i + 1] ?? plan.everyBlock ?? flip - BLOCK_TIME;
    const until = ms(next);
    await wait(Math.max(0, ms(time) - now()));
    for (let attempt = 1; ; attempt++) {
      const started = now();
      try {
        const block = await io.nextBlock(after, time, until);
        if (!block) {
          log.warning("pass skipped, overdue", { at: time, secondsToFlip: flip - time });
          break;
        }
        after = block.number;
        const outcome = await io.pass(block, until);
        log.info("pass done", {
          outcome,
          ms: now() - started,
          block: block.number,
          secondsToFlip: flip - block.timestamp,
        });
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

  if (plan.everyBlock === undefined) return failed;
  await wait(Math.max(0, ms(plan.everyBlock) - now()));
  log.info("passing on every block", { from: plan.everyBlock, flip });
  let last: bigint | undefined;
  let passes = 0;
  let succeeded = 0;
  for (;;) {
    const block = await io.nextBlock(after, 0n, ms(flip + BLOCK_TIME));
    if (!block || block.timestamp >= flip) break;
    if (last !== undefined && block.number > last + 1n) {
      log.warning("blocks skipped", { from: last + 1n, to: block.number - 1n });
    }
    last = after = block.number;
    passes++;
    const until = now() + PASS_BUDGET_MS;
    const started = now();
    try {
      const outcome = await io.pass(block, until);
      succeeded++;
      log.info("pass done", {
        outcome,
        ms: now() - started,
        block: block.number,
        secondsToFlip: flip - block.timestamp,
      });
    } catch (error) {
      log.error("pass failed", { ms: now() - started, block: block.number, error: errorMessage(error) });
    }
  }
  log.info("passed on every block", { passes, failed: passes - succeeded });
  if (succeeded === 0) {
    log.error(passes ? "every pass on every block failed" : "no block seen before the flip");
    failed++;
  }
  return failed;
}

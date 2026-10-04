import type { Hex } from "viem";
import { decideAt, LEAD_MS, sealAt, slots, timing, type Observed, type Pending, type Timing } from "./blocks.ts";
import { errorMessage, log } from "./log.ts";
import type { Vote } from "./select.ts";

const POLL_TIMEOUT_MS = 500;
const POLL_BACKOFF_MS = 2_000; // a poll past its timeout is given this long to settle before the next one
const POLL_GAP_MS = 50;
const TICK_MS = 100;
const MIN_BUDGET_MS = 700; // a decision always gets this long, even once its block was expected to seal

export type Deps<R extends { epoch: { lastVoted: bigint } }, S> = {
  poll: () => Promise<Pending>;
  read: () => Promise<R>;
  decide: (read: R, slot: number) => Vote | null;
  sign: (vote: Vote, read: R) => Promise<S | undefined>;
  send: (signed: S, until: number) => Promise<Hex | undefined>;
};

export type Prepared<R, S> = { snapshot?: R; fallback?: { vote: Vote; signed: S }; readMs: number; signMs: number };

export type Sent = { vote: Vote; hash: Hex };

export type Outcome = { sent: Sent[]; errors: number };

// The global timer, which node's mock timers replace, unlike an import of timers/promises.
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects at `until` (ms) unless `promise` settled first. */
export function within<T>(promise: Promise<T>, until: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), Math.max(0, until - Date.now()));
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Votes in the two last blocks before `flip`, each at the last moment its timing allows. The pending block is polled
 * to refine the timing, which otherwise rests on `seeds` and defaults, so a dead poll delays nothing. A read that
 * fails decides on the last one unless a vote was sent; a signature that fails sends the rehearsed vote once.
 */
export async function runFinal<R extends { epoch: { lastVoted: bigint } }, S>(
  flip: number,
  deps: Deps<R, S>,
  { snapshot, fallback, readMs, signMs }: Prepared<R, S>,
  seeds: number[] = [],
): Promise<Outcome> {
  const observed: Observed = { seeds, seen: [], rtts: [] };
  let latest: Pending | undefined;
  let polled = 0;
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      const started = Date.now();
      const request = deps.poll();
      try {
        const block = await within(request, started + POLL_TIMEOUT_MS);
        const rtt = Date.now() - started;
        polled = Date.now();
        observed.rtts.push(rtt);
        if (block.timestamp > (latest?.timestamp ?? 0)) {
          latest = block;
          observed.seen.push({ timestamp: block.timestamp, seen: Date.now(), rtt });
        }
      } catch {
        await Promise.race([
          request.then(
            () => {},
            () => {},
          ),
          sleep(POLL_BACKOFF_MS),
        ]);
      }
      await sleep(POLL_GAP_MS);
    }
  })();
  const current = () => timing(observed);
  const pipeline = () => ((readMs + signMs) * 5) / 4;
  const due = (i: 0 | 1, t: Timing) => decideAt(slots(flip, t)[i], t, pipeline()) - Date.now();
  // With the poll alive, a stalled chain still takes a vote; without, the last block can seal no later than flip - 1.
  const futile = (t: Timing) =>
    (latest?.timestamp ?? 0) >= flip ||
    (Date.now() - polled > 2 * t.spacing * 1000 && Date.now() >= sealAt(flip - 1, t));
  const sent: Sent[] = [];
  let errors = 0;
  const fail = (message: string, fields: Record<string, unknown>) => (errors++, log.error(message, fields));

  for (const i of [0, 1] as const) {
    let t = current();
    while (due(i, t) > 0) {
      await sleep(Math.min(TICK_MS, due(i, t)));
      t = current();
    }
    const slot = slots(flip, t)[i];
    const pending = latest?.timestamp;
    const sealed = (latest?.timestamp ?? 0) > slot || Date.now() >= sealAt(slot, t);
    if (i === 0 && (sealed || due(1, t) <= 0)) {
      log.warning("penultimate block skipped", { slot, pending, sealed });
      continue;
    }
    if (futile(t)) {
      log.warning("flipped before deciding", { slot, pending });
      break;
    }
    const deadline = Math.max(sealAt(slot, t) - LEAD_MS, Date.now() + MIN_BUDGET_MS);
    log.info("deciding", { slot, pending, budgetMs: deadline - Date.now(), timing: t });
    let read = snapshot;
    let started = Date.now();
    try {
      read = snapshot = await within(deps.read(), deadline - signMs - t.rtt);
      readMs = Math.max(readMs, Date.now() - started);
    } catch (error) {
      if (sent.length) {
        log.warning("read failed after a vote was sent; keeping it", { slot, error: errorMessage(error) });
        continue;
      }
      log.warning("read failed; deciding on the last one", { slot, error: errorMessage(error) });
    }
    if (!read) {
      fail("nothing to decide on", { slot });
      continue;
    }
    if (read.epoch.lastVoted >= BigInt(slot)) {
      log.info("already voted in this block", { slot });
      continue;
    }
    let vote: Vote | null;
    try {
      vote = deps.decide(read, slot);
    } catch (error) {
      fail("decision failed", { slot, error: errorMessage(error) });
      continue;
    }
    if (!vote) continue;
    let signed: S | undefined;
    started = Date.now();
    try {
      signed = await within(deps.sign(vote, read), deadline);
      signMs = Math.max(signMs, Date.now() - started);
    } catch (error) {
      if (!fallback || sent.length) {
        fail("signing failed; nothing to send", { slot, error: errorMessage(error) });
        continue;
      }
      log.warning("signing failed; sending the rehearsed vote", { slot, error: errorMessage(error) });
      ({ vote, signed } = fallback);
    }
    if (signed === undefined) continue;
    if (futile(current())) {
      log.warning("block sealed before sending", { slot, pending: latest?.timestamp });
      continue;
    }
    try {
      const until = Math.max(deadline, Date.now() + MIN_BUDGET_MS);
      const hash = await within(deps.send(signed, until), until + POLL_TIMEOUT_MS);
      if (hash) sent.push({ vote, hash });
      if (signed === fallback?.signed) fallback = undefined;
    } catch (error) {
      fail("send failed", { slot, error: errorMessage(error) });
    }
  }
  stop = true;
  await poller;
  return { sent, errors };
}

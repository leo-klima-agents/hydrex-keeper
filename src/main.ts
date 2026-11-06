import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, CONDUITS, hostOf, now, otherOf, byConduit, type Conduit, type ByConduit } from "./chain.ts";
import { claims } from "./claim.ts";
import { configOf } from "./config.ts";
import { kmsAccount } from "./kms.ts";
import { lastBlocks } from "./last.ts";
import { errorMessage, log } from "./log.ts";
import { pass, perAttempt, readDayBefore, votedDayBefore, type Run } from "./pass.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, readEpoch } from "./read.ts";
import { DAY, HORIZON, lastFlip, task } from "./schedule.ts";
import type { Vote } from "./select.ts";
import { TOP_UP_MS, topUp } from "./topup.ts";
import { pendingVote, VoteSent, type Rival } from "./vote.ts";
import { parseWhitelist } from "./whitelist.ts";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const LAST_MARGIN_MS = 2_000; // no attempt starts this close to the flip

async function main(): Promise<number> {
  const config = configOf(process.argv, process.env);
  const { dryRun, immediately, claimNow, rpcUrls } = config;
  const tokens = parseWhitelist(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));
  const chain = await connect(config.settings, rpcUrls);
  const { conduits } = chain;
  const signers = byConduit((name) => {
    const keyVersion = config.keyVersions[name];
    return keyVersion ? kmsAccount(keyVersion, conduits[name].from) : undefined;
  });
  const { ALCHEMY_API_KEY: alchemyKey, COINGECKO_API_KEY: coingeckoKey } = process.env;
  const source = combined([
    defillama(),
    ...(alchemyKey ? [alchemy(alchemyKey)] : []),
    ...(coingeckoKey ? [coingecko(coingeckoKey)] : []),
  ]);
  const described = ({ address, role, from, to }: Conduit) => ({ address, [role]: from, sendsTo: to });
  log.info("conduits", {
    ...byConduit((name) => described(conduits[name])),
    voter: chain.voter,
    rpcs: rpcUrls.map(hostOf),
    prices: source.name,
    dryRun,
  });

  const run: Run = { chain, tokens, prices: priceFeed(source), signers, dryRun };
  const epoch = await readEpoch(chain);
  const retry = Number(process.env.CLOUD_RUN_TASK_ATTEMPT ?? 0) > 0;
  const todo = task(epoch.flip, now(), { now: immediately, claim: claimNow, dryRun, retry });
  if (todo.what === undefined) {
    // This exit code wins over any other problem, such as a stale epoch. See `task`.
    const message = "nothing due: the job votes a day before the flip and in its last blocks, and claims after it";
    (todo.exit ? log.error : log.warning)(message, { flip: epoch.flip, retry });
    return todo.exit;
  }
  const { what, recheck } = todo;
  if (what === "claims") {
    const flip = lastFlip(epoch.flip, now());
    const until = claimNow ? Date.now() + Number(HORIZON) * 1000 : Number(flip + HORIZON) * 1000;
    return (await claims(run, flip, until)) > 0 ? 1 : 0;
  }
  // The top-up runs first so that the week's votes and claims have the ETH they need. If a top-up transaction's outcome
  // is unknown, the next vote from the same key replaces it at the same nonce with higher fees, so the vote isn't
  // blocked.
  const topUpFailures = what === "day before" ? await topUp(run, Date.now() + TOP_UP_MS) : 0;
  assertFresh(epoch);
  const { flip } = epoch;
  const voting = byConduit((name) => epoch.votes[name].power > 0n);
  for (const name of CONDUITS) {
    const { label, address } = conduits[name];
    if (!voting[name]) log.warning(`${label} has no voting power this epoch: not voting for it`, { conduit: address });
  }
  if (what === "last blocks") {
    const failures = await lastBlocks(run, flip, voting);
    const claimFailures = await claims(run, flip, Number(flip + HORIZON) * 1000);
    return failures + claimFailures > 0 ? 1 : 0;
  }
  if (!immediately) await sleep(Math.max(0, Number(flip - DAY) * 1000 - Date.now()));
  const until = Number(flip) * 1000 - LAST_MARGIN_MS;
  log.info("pass", { flip, secondsToFlip: flip - now() });
  // A retry skips a conduit whose day-before vote is already on chain. The first attempt always votes.
  const voted = async (conduit: Conduit) => recheck && (await votedDayBefore(chain, conduit, flip));
  const reads = perAttempt(() => readDayBefore(run, until));
  // A conduit that checks votes on chain votes after the other's vote is in or has failed, so that its check counts the
  // votes that one moved, and its vote is checked after that one too, which may still be pending. Each conduit retries
  // on its own, and neither depends on the other.
  const passed: Partial<ByConduit<Vote>> = {};
  const rivalOf = async ({ name, priced }: Conduit): Promise<Rival | undefined> => {
    if (!priced) return undefined;
    const other = conduits[otherOf(name)];
    const vote = dryRun ? passed[other.name] : await pendingVote(chain, other);
    return vote && { conduit: other, vote };
  };
  const order = [...CONDUITS].sort((a, b) => Number(!!conduits[a].priced) - Number(!!conduits[b].priced));
  let failures = topUpFailures;
  for (const name of order) {
    const conduit = conduits[name];
    const attempt = async (n: number) => {
      if (await voted(conduit)) return;
      const vote = await pass(run, conduit, await reads(n), until, await rivalOf(conduit));
      if (vote) passed[name] = vote;
    };
    if (voting[name] && !(await attempts(`${name} pass`, attempt, until))) failures++;
  }
  return failures > 0 ? 1 : 0;
}

async function attempts(name: string, pass: (attempt: number) => Promise<void>, until: number): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      await pass(attempt);
      log.info(`${name} done`, { ms: Date.now() - started });
      return true;
    } catch (error) {
      const ms = Date.now() - started;
      const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && Date.now() + RETRY_DELAY_MS < until;
      log.error(`${name} failed${retry ? ", retrying" : ""}`, { attempt, ms, error: errorMessage(error) });
      if (!retry) return false;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error("fatal", { error: errorMessage(error) });
    process.exit(1);
  },
);

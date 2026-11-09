import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { byConduit, connect, hostOf, now, type Conduit } from "./chain.ts";
import { claims } from "./claim.ts";
import { configOf } from "./config.ts";
import { kmsAccount } from "./kms.ts";
import { lastBlocks } from "./last.ts";
import { errorMessage, log } from "./log.ts";
import { dayBefore, votingOf, type Run } from "./pass.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, readEpoch } from "./read.ts";
import { DAY, HORIZON, lastFlip, task } from "./schedule.ts";
import { TOP_UP_MS, topUp } from "./topup.ts";
import { parseWhitelist } from "./whitelist.ts";

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
  const voting = votingOf(chain, epoch);
  if (what === "last blocks") {
    const failures = await lastBlocks(run, flip, voting);
    const claimFailures = await claims(run, flip, Number(flip + HORIZON) * 1000);
    return failures + claimFailures > 0 ? 1 : 0;
  }
  if (!immediately) await sleep(Math.max(0, Number(flip - DAY) * 1000 - Date.now()));
  const until = Number(flip) * 1000 - LAST_MARGIN_MS;
  log.info("pass", { flip, secondsToFlip: flip - now() });
  // A retry skips a conduit whose day-before vote is already on chain. The first attempt always votes.
  const failures = await dayBefore(run, flip, voting, { recheck, until });
  return topUpFailures + failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error("fatal", { error: errorMessage(error) });
    process.exit(1);
  },
);

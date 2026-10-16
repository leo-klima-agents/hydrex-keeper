import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { getAddress } from "viem";
import { connect, hostOf, now } from "./chain.ts";
import { claims } from "./claim.ts";
import { kmsAccount } from "./kms.ts";
import { lastBlocks } from "./last.ts";
import { errorMessage, log } from "./log.ts";
import { pass, type Run } from "./pass.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, readEpoch } from "./read.ts";
import { DAY, due, HORIZON, lastFlip } from "./schedule.ts";
import { VoteSent } from "./vote.ts";
import { parseWhitelist } from "./whitelist.ts";

// Tried after BASE_RPC_URLS. Rate-limited: Base calls its own "not suitable for production apps".
const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const LAST_MARGIN_MS = 2_000; // nothing is attempted this close to the flip

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const claimNow = process.argv.includes("--claim");
  if (immediately && claimNow) throw new Error("--now and --claim exclude each other");
  const module = getAddress(required("MODULE"));
  const keyVersion = dryRun ? process.env.KMS_KEY_VERSION : required("KMS_KEY_VERSION");
  const tokens = parseWhitelist(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));

  const configured = required("BASE_RPC_URLS").split(",");
  const rpcUrls = [...new Set([...configured, ...PUBLIC_RPCS].map((url) => url.trim()).filter(Boolean))];
  const chain = await connect(module, rpcUrls);
  const account = keyVersion ? kmsAccount(keyVersion, chain.keeper) : undefined;
  const { ALCHEMY_API_KEY: alchemyKey, COINGECKO_API_KEY: coingeckoKey } = process.env;
  const source = combined([
    defillama(),
    ...(alchemyKey ? [alchemy(alchemyKey)] : []),
    ...(coingeckoKey ? [coingecko(coingeckoKey)] : []),
  ]);
  const { keeper, conduit, voter } = chain;
  log.info("keeper", { module, keeper, conduit, voter, rpcs: rpcUrls.map(hostOf), prices: source.name, dryRun });

  const run: Run = { chain, tokens, prices: priceFeed(source), account, dryRun };
  const epoch = await readEpoch(chain);
  const scheduled = due(epoch.flip, now());
  // A claim sent by hand could take the nonce of what the schedule sends at the same time. A dry run sends nothing.
  const sends = { claims: "claims", "day before": "vote of a day before the flip", "last blocks": "last-block votes" };
  if (claimNow && scheduled && !dryRun) {
    throw new Error(`--claim would race the scheduled ${sends[scheduled]}: run it later`);
  }
  const what = claimNow ? "claims" : immediately ? "day before" : scheduled;
  if (what === "claims") {
    const flip = lastFlip(epoch.flip, now());
    const until = claimNow ? Date.now() + Number(HORIZON) * 1000 : Number(flip + HORIZON) * 1000;
    return (await claims(run, flip, until)) ? 1 : 0;
  }
  if (!what && epoch.flip <= now() && now() - epoch.flip < 2n * HORIZON) {
    // Retries of claims that waited all hour for the minter end here: those claims already failed.
    log.warning("nothing due: the hour of the claims is over, and the minter has not started the epoch", {
      flip: epoch.flip,
    });
    return 0;
  }
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");
  const { flip } = epoch;
  if (what === "last blocks") {
    const failures = await lastBlocks(run, flip);
    return failures + (await claims(run, flip, Number(flip + HORIZON) * 1000)) > 0 ? 1 : 0;
  }
  if (!what) {
    log.warning("nothing due: the job votes a day before the flip and in its last blocks, and claims after it", {
      flip,
    });
    return 0;
  }
  if (!immediately) await sleep(Math.max(0, Number(flip - DAY) * 1000 - Date.now()));
  const until = Number(flip) * 1000 - LAST_MARGIN_MS;
  log.info("pass", { flip, secondsToFlip: flip - now() });
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      await pass(run, until);
      log.info("pass done", { ms: Date.now() - started });
      return 0;
    } catch (error) {
      const ms = Date.now() - started;
      const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && Date.now() + RETRY_DELAY_MS < until;
      log.error(`pass failed${retry ? ", retrying" : ""}`, { attempt, ms, error: errorMessage(error) });
      if (!retry) return 1;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error("fatal", { error: errorMessage(error) });
    process.exit(1);
  },
);

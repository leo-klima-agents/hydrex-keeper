import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { getAddress } from "viem";
import { connect, hostOf, now } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { lastBlocks, WARMUP_MS } from "./last.ts";
import { errorMessage, log } from "./log.ts";
import { pass, type Run } from "./pass.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, readEpoch } from "./read.ts";
import { HORIZON, schedule } from "./schedule.ts";
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
  const module = getAddress(required("MODULE"));
  const keyVersion = dryRun ? process.env.KMS_KEY_VERSION : required("KMS_KEY_VERSION");
  const offsetFields = immediately ? [] : required("VOTE_OFFSETS").split(",");
  if (!offsetFields.every((s) => /^[0-9]+$/.test(s))) throw new Error("VOTE_OFFSETS must be comma-separated seconds");
  const offsets = offsetFields.map(BigInt);
  const whitelist = parseWhitelist(readFileSync(new URL("../pools.json", import.meta.url), "utf8"));

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

  const epoch = await readEpoch(chain);
  if (!immediately && epoch.flip <= now() && now() - epoch.flip < HORIZON) {
    log.warning("restarted after the flip; nothing to do", { flip: epoch.flip });
    return 0;
  }
  assertFresh(epoch);
  const { flip } = epoch;
  const { times, note } = schedule(flip, offsets, now(), immediately);
  if (note) log.warning(note, { flip });
  if (times.length === 0) return 0;
  const deadline = Number(flip) * 1000 - LAST_MARGIN_MS;
  const run: Run = { chain, whitelist, prices: priceFeed(source), account, dryRun };

  const start = (time: bigint) => Number(time) * 1000 - (time === flip ? WARMUP_MS : 0);
  let failed = 0;
  for (const [i, time] of times.entries()) {
    if (time === flip) {
      failed += await lastBlocks(run, flip);
      continue;
    }
    const until = i + 1 < times.length ? start(times[i + 1]!) : deadline;
    await sleep(Math.max(0, Math.min(start(time), until) - Date.now()));
    if (Date.now() >= until) {
      log.warning("pass skipped, overdue", { at: time, secondsToFlip: flip - now() });
      continue;
    }
    log.info("pass", { at: time, flip, secondsToFlip: flip - now() });
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        await pass(run, until);
        log.info("pass done", { ms: Date.now() - started, secondsToFlip: flip - now() });
        break;
      } catch (error) {
        const ms = Date.now() - started;
        const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && Date.now() + RETRY_DELAY_MS < until;
        log.error(`pass failed${retry ? ", retrying" : ""}`, { attempt, ms, error: errorMessage(error) });
        if (!retry) {
          failed++;
          break;
        }
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return failed ? 1 : 0;
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

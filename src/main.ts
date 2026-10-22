import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { getAddress, isAddressEqual } from "viem";
import { connect, hostOf, now, type Chain, type V2 } from "./chain.ts";
import { claims } from "./claim.ts";
import { connectV2 } from "./immutable.ts";
import { kmsAccount } from "./kms.ts";
import { lastBlocks } from "./last.ts";
import { errorMessage, log } from "./log.ts";
import { pass, passV2, perAttempt, readDayBefore, votedDayBefore, type Run } from "./pass.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, readEpoch } from "./read.ts";
import { DAY, HORIZON, lastFlip, task } from "./schedule.ts";
import type { Vote } from "./select.ts";
import { TOP_UP_MS, topUp } from "./topup.ts";
import { klimaSender, v2Sender, VoteSent, type Sender } from "./vote.ts";
import { parseWhitelist } from "./whitelist.ts";

// Tried after BASE_RPC_URLS. They are rate-limited, so they are only a fallback.
const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const LAST_MARGIN_MS = 2_000; // no attempt starts this close to the flip

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const claimNow = process.argv.includes("--claim");
  if (immediately && claimNow) throw new Error("--now and --claim exclude each other");
  const module = getAddress(required("MODULE"));
  const keyVersion = dryRun ? process.env.KMS_KEY_VERSION : required("KMS_KEY_VERSION");
  // Immutable conduit problems fail the run, but only after the Klima conduit has voted or claimed.
  let failed = false;
  const unusable = (error: unknown) => {
    failed = true;
    log.error("immutable conduit unusable: not voting for it", { v2: process.env.CONDUIT, error: errorMessage(error) });
    return undefined;
  };
  const config = (() => {
    try {
      return immutableConduit(dryRun);
    } catch (error) {
      return unusable(error);
    }
  })();
  const tokens = parseWhitelist(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));

  const configured = required("BASE_RPC_URLS").split(",");
  const rpcUrls = [...new Set([...configured, ...PUBLIC_RPCS].map((url) => url.trim()).filter(Boolean))];
  const chain = await connect(module, rpcUrls);
  // The two keys send at the same time and their nonces are tracked separately, so they must differ.
  if (config && isAddressEqual(config.proposer, chain.keeper)) {
    unusable(new Error(`PROPOSER is the keeper, ${chain.keeper}: each needs nonces of its own`));
  } else if (config) chain.v2 = await reachV2(chain, config).catch(unusable);
  const account = keyVersion ? kmsAccount(keyVersion, chain.keeper) : undefined;
  const proposer = chain.v2 && config?.keyVersion ? kmsAccount(config.keyVersion, chain.v2.proposer) : undefined;
  const { ALCHEMY_API_KEY: alchemyKey, COINGECKO_API_KEY: coingeckoKey } = process.env;
  const source = combined([
    defillama(),
    ...(alchemyKey ? [alchemy(alchemyKey)] : []),
    ...(coingeckoKey ? [coingecko(coingeckoKey)] : []),
  ]);
  const { keeper, conduit, voter } = chain;
  const v2Fields = chain.v2 ? { v2: chain.v2.conduit, proposer: chain.v2.proposer } : {};
  log.info("keeper", {
    module,
    keeper,
    conduit,
    voter,
    ...v2Fields,
    rpcs: rpcUrls.map(hostOf),
    prices: source.name,
    dryRun,
  });

  const run: Run = { chain, tokens, prices: priceFeed(source), account, proposer, dryRun };
  const epoch = await readEpoch(chain);
  const retry = Number(process.env.CLOUD_RUN_TASK_ATTEMPT ?? 0) > 0;
  const todo = task(epoch.flip, now(), { now: immediately, claim: claimNow, dryRun, retry });
  if (todo.what === undefined) {
    // This exit code wins over any other problem, such as an unusable CONDUIT or a stale epoch. See `task`.
    const message = "nothing due: the job votes a day before the flip and in its last blocks, and claims after it";
    (todo.exit ? log.error : log.warning)(message, { flip: epoch.flip, retry });
    return todo.exit;
  }
  const { what, recheck } = todo;
  if (what === "claims") {
    const flip = lastFlip(epoch.flip, now());
    const until = claimNow ? Date.now() + Number(HORIZON) * 1000 : Number(flip + HORIZON) * 1000;
    return (await claims(run, flip, until)) || failed ? 1 : 0;
  }
  // The top-up runs first so that the week's votes and claims have the ETH they need. If a top-up transaction's outcome
  // is unknown, the proposer's vote replaces it at the same nonce with higher fees, so the vote isn't blocked.
  const topUpFailures = what === "day before" ? await topUp(run, Date.now() + TOP_UP_MS) : 0;
  assertFresh(epoch);
  const { flip } = epoch;
  const klima = epoch.power > 0n;
  if (!klima) {
    failed = true;
    log.error("the Klima conduit has no voting power this epoch: not voting for it");
  }
  const v2 = chain.v2 !== undefined && (epoch.v2?.power ?? 0n) > 0n;
  if (chain.v2 && !v2) log.warning("the immutable conduit has no voting power this epoch: not voting for it");
  if (what === "last blocks") {
    const failures = await lastBlocks(run, flip, { klima, v2 });
    const claimFailures = await claims(run, flip, Number(flip + HORIZON) * 1000);
    return failed || failures + claimFailures > 0 ? 1 : 0;
  }
  if (!immediately) await sleep(Math.max(0, Number(flip - DAY) * 1000 - Date.now()));
  const until = Number(flip) * 1000 - LAST_MARGIN_MS;
  log.info("pass", { flip, secondsToFlip: flip - now() });
  // A retry skips a conduit whose day-before vote is already on chain. The first attempt always votes.
  const voted = async (sender: Sender) => recheck && (await votedDayBefore(chain, sender, flip));
  const reads = perAttempt(() => readDayBefore(run, until));
  // The immutable conduit votes after the Klima conduit's vote is in or has failed, so that its check counts the votes
  // that one moved. It is also checked after that vote, which may still be pending. Each conduit retries on its own,
  // and neither depends on the other.
  let klimaVote: Vote | undefined;
  const klimaPass = async (attempt: number) => {
    if (await voted(klimaSender(chain))) return;
    klimaVote = await pass(run, await reads(attempt), until);
  };
  const klimaDone = !klima || (await attempts("pass", klimaPass, until));
  const v2Pass = async (attempt: number) => {
    if (await voted(v2Sender(chain))) return;
    await passV2(run, await reads(attempt), until, klimaVote);
  };
  const v2Done = !v2 || (await attempts("v2 pass", v2Pass, until));
  return failed || topUpFailures > 0 || !klimaDone || !v2Done ? 1 : 0;
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

/** Retried, because one failed read would leave the immutable conduit out until the flip. */
async function reachV2(chain: Chain, config: Omit<V2, "priced">): Promise<V2> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connectV2(chain, config);
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
      log.warning("immutable conduit not reached, retrying", { attempt, error: errorMessage(error) });
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function immutableConduit(dryRun: boolean): (Omit<V2, "priced"> & { keyVersion: string | undefined }) | undefined {
  const { CONDUIT: conduit, PROPOSER: proposer, PROPOSER_KMS_KEY_VERSION: keyVersion } = process.env;
  if (!conduit && !proposer && !keyVersion) return undefined;
  if (!conduit || !proposer || (!keyVersion && !dryRun)) {
    throw new Error("CONDUIT, PROPOSER and PROPOSER_KMS_KEY_VERSION go together");
  }
  return { conduit: getAddress(conduit), proposer: getAddress(proposer), keyVersion };
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

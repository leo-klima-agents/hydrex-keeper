import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { getAddress, isAddressEqual } from "viem";
import { connect, hostOf, now, type Chain, type V2 } from "./chain.ts";
import { claims } from "./claim.ts";
import { connectV2 } from "./immutable.ts";
import { kmsAccount } from "./kms.ts";
import { lastBlocks } from "./last.ts";
import { errorMessage, log } from "./log.ts";
import { pass, passV2, perAttempt, readDayBefore, type Run } from "./pass.ts";
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
  // The immutable conduit's failures fail the execution, once the Klima conduit has voted or claimed without it.
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
  // Each key's nonces are tracked apart, and the two send votes and claims at once.
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
    return (await claims(run, flip, until)) || failed ? 1 : 0;
  }
  if (!what && epoch.flip <= now() && now() - epoch.flip < 2n * HORIZON) {
    // Retries of claims that waited all hour for the minter end here: those claims already failed.
    log.warning("nothing due: the hour of the claims is over, and the minter has not started the epoch", {
      flip: epoch.flip,
    });
    return 0;
  }
  assertFresh(epoch);
  const { flip } = epoch;
  // Each conduit votes if it has voting power this epoch, whatever becomes of the other.
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
  if (!what) {
    log.warning("nothing due: the job votes a day before the flip and in its last blocks, and claims after it", {
      flip,
    });
    return failed ? 1 : 0;
  }
  if (!immediately) await sleep(Math.max(0, Number(flip - DAY) * 1000 - Date.now()));
  const until = Number(flip) * 1000 - LAST_MARGIN_MS;
  log.info("pass", { flip, secondsToFlip: flip - now() });
  // A retry of a failed execution does not vote again for a conduit whose vote of a day before is in. Anyone may vote
  // for the immutable conduit, so the first execution votes whatever the conduits' last votes.
  const retry = Number(process.env.CLOUD_RUN_TASK_ATTEMPT ?? 0) > 0;
  const again = (lastVoted: bigint | undefined, conduit: string) => {
    const voted = retry && !immediately && lastVoted !== undefined && lastVoted >= flip - DAY - HORIZON;
    if (voted) log.info("already voted a day before the flip", { conduit, lastVoted });
    return !voted;
  };
  const reads = perAttempt(() => readDayBefore(run, until));
  // The immutable conduit votes once the Klima conduit's vote is in, or has failed, so that its check counts the votes
  // that one moves. The two are retried apart, and either votes whatever becomes of the other.
  const klimaDone =
    !klima ||
    !again(epoch.lastVoted, chain.conduit) ||
    (await attempts("pass", async (attempt) => pass(run, await reads(attempt), until), until));
  const v2Done =
    !v2 ||
    !again(epoch.v2?.lastVoted, chain.v2!.conduit) ||
    (await attempts("v2 pass", async (attempt) => passV2(run, await reads(attempt), until), until));
  return failed || !klimaDone || !v2Done ? 1 : 0;
}

/** Runs `pass` up to ATTEMPTS times, while time is left before `until` (ms); returns whether it succeeded. */
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

/** connectV2, tried up to ATTEMPTS times: one failed read would leave out the immutable conduit until the flip. */
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

/**
 * The immutable conduit the job also votes for, the address that signs its votes, and its key: CONDUIT, PROPOSER and
 * PROPOSER_KMS_KEY_VERSION, all or none. A dry run may leave out the key.
 */
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

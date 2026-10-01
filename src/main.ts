import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { connect, hostOf, now, type Chain } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, LayoutChanged, readEpoch, readLayout, readPass, type Layout } from "./read.ts";
import { blockInterval, GRACE_MS, HORIZON, lastBlocks, lastBlocksStart, schedule } from "./schedule.ts";
import { expected, select, type Candidate } from "./select.ts";
import { castVote, confirmVote, VoteSent, type Sent } from "./vote.ts";
import { parseWhitelist, type Whitelist } from "./whitelist.ts";

// Tried after BASE_RPC_URLS. Rate-limited: Base calls its own "not suitable for production apps".
const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

type Run = {
  chain: Chain;
  whitelist: Whitelist;
  layout?: Layout;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

async function pass(run: Run, until: number): Promise<Sent | undefined> {
  const { chain, whitelist, prices, account, dryRun } = run;
  const pools = whitelist.map((w) => w.pool);
  run.layout ??= await readLayout(chain, pools);
  let read;
  try {
    read = await readPass(chain, run.layout);
  } catch (error) {
    if (!(error instanceof LayoutChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.layout = await readLayout(chain, pools);
    read = await readPass(chain, run.layout);
  }
  const { epoch, rewards } = read;
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");

  const tokens = rewards.flatMap((p) => p.rewards.map((r) => r.token));
  const priced = await prices(tokens, until);
  if (priced.size === 0 && tokens.length > 0) throw new Error("no reward token could be priced");
  const candidates: Candidate[] = [];
  const nameOf = (pool: Address) => whitelist.find((w) => w.pool === pool)?.name ?? pool;
  for (const p of rewards) {
    const pool = nameOf(p.pool);
    const detail = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const unpriced = detail.filter((d) => d.usd === null);
    if (unpriced.length) log.warning("unpriced rewards count as zero", { pool, unpriced });
    const rewardsUsd = detail.reduce((sum, d) => sum + (d.usd ?? 0), 0);
    const candidate = { pool: p.pool, rewardsUsd, otherVotes: p.otherVotes, ownVotes: p.ownVotes };
    if (p.alive) candidates.push(candidate);
    else log.warning("gauge is dead, skipping", { pool });
    log.info("candidate", { ...candidate, pool, alive: p.alive, rewards: detail });
  }

  if (candidates.length === 0) throw new Error("no whitelisted pool has a live gauge");
  const { fractions, vote } = select(candidates, epoch.power);
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: nameOf(candidates[i]!.pool), share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = rewards.filter((p) => p.ownVotes > 0n).map((p) => ({ pool: nameOf(p.pool), votes: p.ownVotes }));
  if (!vote) {
    const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
    log.info(reason, { plan, expectedUsd, currentVote });
    return;
  }
  log.info("voting", { plan, expectedUsd, currentVote, power: epoch.power });
  return castVote(chain, account, vote, dryRun, until);
}

/**
 * Runs a pass two blocks before the last ones, then one on each of them as it appears, and confirms the last vote
 * sent. False if the last pass or that vote failed before the flip, or if no block was seen.
 */
async function voteLastBlocks(run: Run, flip: bigint, interval: number): Promise<boolean> {
  const until = Number(flip) * 1000 + GRACE_MS;
  let sent: Sent | undefined;
  let ok = true;
  const attempt = async (fields: Record<string, unknown>) => {
    const started = Date.now();
    log.info("pass", { ...fields, flip, secondsToFlip: flip - now() });
    try {
      sent = (await pass(run, until)) ?? sent;
      log.info("pass done", { ms: Date.now() - started, secondsToFlip: flip - now() });
      ok = true;
    } catch (error) {
      const failure = { ms: Date.now() - started, error: errorMessage(error) };
      if (now() >= flip) {
        log.warning("pass failed after the flip", failure);
      } else {
        ok = false;
        log.error("pass failed", failure);
      }
    }
  };
  await sleep(Math.max(0, lastBlocksStart(flip, interval) - Date.now()));
  await attempt({ interval });
  let blocks = 0;
  for await (const head of lastBlocks(run.chain.client, flip, interval)) {
    blocks++;
    await attempt({ block: head.number, timestamp: head.timestamp });
  }
  if (!blocks) {
    log.error("no block seen in the last window");
    ok = false;
  }
  if (!sent) return ok;
  try {
    await confirmVote(run.chain, sent, flip, until);
    return ok;
  } catch (error) {
    log.error("last vote failed", { error: errorMessage(error) });
    return false;
  }
}

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
  const { times, last, note } = schedule(flip, offsets, now(), immediately);
  if (note) log.warning(note, { flip });
  if (times.length === 0 && !last) return 0;
  const interval = last ? await blockInterval(chain.client) : 0;
  const start = last ? lastBlocksStart(flip, interval) : Infinity;
  const run: Run = { chain, whitelist, prices: priceFeed(source), account, dryRun };

  let failed = 0;
  for (const [i, time] of times.entries()) {
    await sleep(Math.max(0, Number(time) * 1000 - Date.now()));
    const until = Math.min(i + 1 < times.length ? Number(times[i + 1]!) * 1000 : Infinity, start);
    if (Date.now() >= until) {
      log.warning("pass skipped, overdue", { at: time, secondsToFlip: flip - now() });
      continue;
    }
    log.info("pass", { at: time, flip, secondsToFlip: flip - now() });
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        const sent = await pass(run, until);
        if (sent) await confirmVote(chain, sent, flip, until);
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
  if (last && !(await voteLastBlocks(run, flip, interval))) failed++;
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

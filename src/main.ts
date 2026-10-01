import { readFileSync } from "node:fs";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { BLOCK_TIME, connect, hostOf, nextBlock, now, WEEK, type Block, type Chain } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import { alchemy, coingecko, combined, defillama, priceFeed } from "./prices.ts";
import { assertFresh, calendarEpoch, LayoutChanged, readEpoch, readLayout, readPass, type Layout } from "./read.ts";
import { runPasses, type Outcome } from "./run.ts";
import { HORIZON, modeAt, schedule } from "./schedule.ts";
import { expected, select, type Candidate } from "./select.ts";
import { castVote } from "./vote.ts";
import { parseWhitelist, type Whitelist } from "./whitelist.ts";

// Tried after BASE_RPC_URLS. Rate-limited: Base calls its own "not suitable for production apps".
const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];

type Run = {
  chain: Chain;
  whitelist: Whitelist;
  layout?: Layout;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
  flip: bigint;
};

/** One pass at `block`: reads the state there, splits the votes, and votes if that pays, waiting at most until `until` (ms). */
async function pass(run: Run, block: Block, until: number): Promise<Outcome> {
  const { chain, whitelist, prices, account, dryRun, flip } = run;
  const mode = modeAt(block.timestamp, flip);
  log.info("pass", { block: block.number, timestamp: block.timestamp, secondsToFlip: flip - block.timestamp, mode });
  const pools = whitelist.map((w) => w.pool);
  const at = { epoch: flip - WEEK, blockNumber: block.number };
  run.layout ??= await readLayout(chain, pools);
  let read;
  try {
    read = await readPass(chain, run.layout, at);
  } catch (error) {
    if (!(error instanceof LayoutChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.layout = await readLayout(chain, pools);
    read = await readPass(chain, run.layout, at);
  }
  const { epoch, rewards } = read;
  assertFresh(epoch, at.epoch);
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
  const { fractions, vote } = select(candidates, epoch.power, mode);
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: nameOf(candidates[i]!.pool), share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = rewards.filter((p) => p.ownVotes > 0n).map((p) => ({ pool: nameOf(p.pool), votes: p.ownVotes }));
  if (!vote) {
    const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
    log.info(reason, { mode, plan, expectedUsd, currentVote });
    return "kept";
  }
  if (block.timestamp + BLOCK_TIME > flip || Date.now() >= until) {
    // The vote would be mined after the flip, where the Voter rejects it until the minter is updated; a vote
    // mined exactly at the flip is still accepted.
    log.info("not sent: too late to be mined before the flip", { mode, plan, expectedUsd, currentVote });
    return "skipped";
  }
  log.info("voting", { mode, plan, expectedUsd, currentVote, power: epoch.power });
  const sent = await castVote(chain, account, vote, dryRun, until);
  return sent === "unconfirmed" ? "pending" : "voted";
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const module = getAddress(required("MODULE"));
  const keyVersion = dryRun ? process.env.KMS_KEY_VERSION : required("KMS_KEY_VERSION");
  const offsetFields = immediately ? [] : required("VOTE_OFFSETS").split(",");
  if (!offsetFields.every((s) => /^[0-9]+$/.test(s))) throw new Error("VOTE_OFFSETS must be comma-separated seconds");
  const offsets = offsetFields.map(BigInt);
  const everyBlockField = immediately ? "0" : required("EVERY_BLOCK_FROM");
  if (!/^[0-9]+$/.test(everyBlockField)) throw new Error("EVERY_BLOCK_FROM must be seconds");
  const everyBlockFrom = BigInt(everyBlockField);
  if (offsets.some((o) => o <= everyBlockFrom))
    throw new Error("VOTE_OFFSETS entries must be larger than EVERY_BLOCK_FROM");
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
  assertFresh(epoch, calendarEpoch());
  const { flip } = epoch;
  const plan = schedule(flip, offsets, everyBlockFrom, now(), immediately);
  if (plan.note) log.warning(plan.note, { flip });
  const run: Run = { chain, whitelist, prices: priceFeed(source), account, dryRun, flip };
  const failed = await runPasses(plan, flip, {
    nextBlock: (after, mintedAt, until) => nextBlock(chain.client, { after, mintedAt, until }),
    pass: (block, until) => pass(run, block, until),
  });
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

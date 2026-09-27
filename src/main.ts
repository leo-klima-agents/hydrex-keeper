import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { connect, now, WEEK, type Chain } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { describe, log } from "./log.ts";
import { priceFeed } from "./prices.ts";
import { readEpoch, readRewards, readStatic, StaticChanged, type Epoch, type Static } from "./rewards.ts";
import { expected, select, type Candidate } from "./select.ts";
import { castVote, VoteSent } from "./vote.ts";

const PUBLIC_RPC = "https://mainnet.base.org";
const HORIZON = 3600n; // an execution runs the passes due within this many seconds
const ATTEMPTS = 3;
const RETRY_DELAY = 5_000;
const LAST_MARGIN = 2_000; // ms before the flip after which nothing is attempted

type Whitelist = { pool: Address; name: string }[];

/** Times (unix seconds) of the passes due within the horizon, earliest first. */
export function passTimes(flip: bigint, offsets: bigint[], at: bigint, horizon = HORIZON): bigint[] {
  return [...new Set(offsets.map((o) => flip - o))].filter((t) => t > at && t <= at + horizon).sort((a, b) => (a < b ? -1 : 1));
}

/** Whether a pass fell due within the horizon before `at`. */
export function missed(flip: bigint, offsets: bigint[], at: bigint): boolean {
  return offsets.some((o) => flip - o <= at && flip - o > at - HORIZON);
}

/** The passes this execution runs: the ones due ahead, or a missed one right now, or none. */
export function schedule(flip: bigint, offsets: bigint[], at: bigint, immediately: boolean): { times: bigint[]; note?: string } {
  if (immediately) return { times: [at] };
  const times = passTimes(flip, offsets, at);
  if (times.length) return { times };
  if (flip > at && missed(flip, offsets, at)) return { times: [at], note: "running the missed pass now" };
  return { times: [], note: `no pass due within ${HORIZON} s: the epoch flips at ${flip}, offsets ${offsets.join(",")}` };
}

function assertFresh(epoch: Epoch): void {
  const t = now();
  if (epoch.start !== (t / WEEK) * WEEK) throw new Error(`Voter epoch ${epoch.start} is stale at ${t}; minter not updated`);
}

type Run = {
  chain: Chain;
  whitelist: Whitelist;
  static?: Static;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

async function pass(run: Run, until: number): Promise<void> {
  const { chain, whitelist, prices, account, dryRun } = run;
  const epoch = await readEpoch(chain);
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");

  const pools = whitelist.map((w) => w.pool);
  run.static ??= await readStatic(chain, pools);
  let rewards;
  try {
    rewards = await readRewards(chain, run.static, epoch);
  } catch (error) {
    if (!(error instanceof StaticChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.static = await readStatic(chain, pools);
    rewards = await readRewards(chain, run.static, epoch);
  }
  const priced = await prices(rewards.flatMap((p) => p.rewards.map((r) => r.token)), until);
  if (priced.size === 0 && rewards.some((p) => p.rewards.length > 0)) throw new Error("no reward token could be priced");
  const candidates: Candidate[] = [];
  const nameOf = (pool: Address) => whitelist.find((w) => w.pool === pool)?.name ?? pool;
  for (const p of rewards) {
    const detail = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const rewardsUsd = detail.reduce((sum, d) => sum + (d.usd ?? 0), 0);
    const unpriced = detail.filter((d) => d.usd === null);
    if (unpriced.length) log.warning("unpriced rewards count as zero", { pool: nameOf(p.pool), unpriced });
    if (!p.alive) log.warning("gauge is dead, skipping", { pool: nameOf(p.pool) });
    else candidates.push({ pool: p.pool, rewardsUsd, otherVotes: p.otherVotes, ownVotes: p.ownVotes });
    log.info("candidate", { pool: nameOf(p.pool), alive: p.alive, rewardsUsd, otherVotes: p.otherVotes, ownVotes: p.ownVotes, rewards: detail });
  }

  if (candidates.length === 0) throw new Error("no whitelisted pool has a live gauge");
  const { fractions, vote } = select(candidates, epoch.power);
  const plan = fractions ? candidates.map((c, i) => ({ pool: nameOf(c.pool), share: Math.round(fractions[i]! * 10_000) / 100 })).filter((p) => p.share > 0) : [];
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = rewards.filter((p) => p.ownVotes > 0n).map((p) => ({ pool: nameOf(p.pool), votes: p.ownVotes }));
  if (!vote) {
    log.info(fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote", { plan, expectedUsd, currentVote });
    return;
  }
  log.info("voting", { plan, expectedUsd, pools: vote.pools.map(nameOf), weights: vote.weights, currentVote, power: epoch.power });
  await castVote(chain, account, vote, dryRun, until);
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const module = getAddress(required("MODULE"));
  const keyVersion = dryRun ? process.env.KMS_KEY_VERSION : required("KMS_KEY_VERSION");
  const offsetFields = immediately ? [] : required("VOTE_OFFSETS").split(",");
  if (!offsetFields.every((s) => /^[0-9]+$/.test(s))) throw new Error("VOTE_OFFSETS must be comma-separated seconds");
  const offsets = offsetFields.map(BigInt);
  const whitelist = (JSON.parse(readFileSync(new URL("../pools.json", import.meta.url), "utf8")) as Whitelist).map(
    (w) => ({ pool: getAddress(w.pool), name: String(w.name) }),
  );
  if (whitelist.length === 0) throw new Error("pools.json is empty");

  const chain = await connect(module, [...required("BASE_RPC_URL").split(","), PUBLIC_RPC].map((url) => url.trim()));
  const account = keyVersion ? kmsAccount(keyVersion, chain.keeper) : undefined;
  log.info("keeper", { module, keeper: chain.keeper, conduit: chain.conduit, voter: chain.voter, dryRun });

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
  const deadline = Number(flip) * 1000 - LAST_MARGIN;
  const run: Run = { chain, whitelist, prices: priceFeed(), account, dryRun };
  try {
    run.static = await readStatic(chain, whitelist.map((w) => w.pool));
  } catch (error) {
    log.warning("static read failed; the first pass retries it", { error: describe(error) });
  }

  let failed = 0;
  for (const [i, time] of times.entries()) {
    await sleep(Math.max(0, Number(time) * 1000 - Date.now()));
    const until = i + 1 < times.length ? Number(times[i + 1]!) * 1000 : deadline;
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
        const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && Date.now() + RETRY_DELAY < until;
        log.error(`pass failed${retry ? ", retrying" : ""}`, { attempt, ms: Date.now() - started, error: describe(error) });
        if (!retry) {
          failed++;
          break;
        }
        await sleep(RETRY_DELAY);
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

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      log.error("fatal", { error: describe(error) });
      process.exit(1);
    },
  );
}

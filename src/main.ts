import { readFileSync, realpathSync } from "node:fs";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { connect, WEEK, type Chain } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { describe, log } from "./log.ts";
import { priceFeed } from "./prices.ts";
import { readEpoch, readRewards, readStatic, StaticChanged, type Epoch, type Static } from "./rewards.ts";
import { select, type Candidate } from "./select.ts";
import { castVote, sameVote, VoteSent } from "./vote.ts";

const PUBLIC_RPC = "https://mainnet.base.org";
const DEFAULT_OFFSETS = "86400,600,200,70,25,10,5";
const HORIZON = 3600n; // an execution runs the passes due within this many seconds
const PRICE_MAX_AGE = 30 * 60_000;
const ATTEMPTS = 3;
const RETRY_DELAY = 5_000;
const LAST_MARGIN = 2_000; // ms before the flip after which nothing is attempted

type Whitelist = { pool: Address; name: string }[];

const now = () => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Times (unix seconds) of the passes due within the horizon, earliest first. */
export function passTimes(flip: bigint, offsets: bigint[], at: bigint, horizon = HORIZON): bigint[] {
  return [...new Set(offsets.map((o) => flip - o))].filter((t) => t > at && t <= at + horizon).sort((a, b) => (a < b ? -1 : 1));
}

/** Whether a pass was due within the horizon before `at`: a late start, as opposed to a restart after the flip. */
export function missed(flip: bigint, offsets: bigint[], at: bigint, horizon = HORIZON): boolean {
  return offsets.some((o) => flip - o <= at && flip - o > at - horizon);
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
  prices: (tokens: Address[]) => Promise<Map<Address, number>>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

async function pass(run: Run, until: bigint): Promise<void> {
  const { chain, whitelist, prices, account, dryRun } = run;
  const epoch = await readEpoch(chain);
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");

  run.static ??= await readStatic(chain, whitelist.map((w) => w.pool));
  let rewards;
  try {
    rewards = await readRewards(chain, run.static, epoch);
  } catch (error) {
    if (!(error instanceof StaticChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.static = await readStatic(chain, whitelist.map((w) => w.pool));
    rewards = await readRewards(chain, run.static, epoch);
  }
  const priced = await prices(rewards.flatMap((p) => p.rewards.map((r) => r.token)));
  const candidates: Candidate[] = [];
  const nameOf = (pool: Address) => whitelist.find((w) => w.pool === pool)?.name ?? pool;
  for (const [i, p] of rewards.entries()) {
    const detail = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const rewardsUsd = detail.reduce((sum, d) => sum + (d.usd ?? 0), 0);
    const unpriced = detail.filter((d) => d.usd === null);
    if (unpriced.length) log.warning("unpriced rewards count as zero", { pool: nameOf(p.pool), unpriced });
    if (!p.alive) log.warning("gauge is dead, skipping", { pool: nameOf(p.pool) });
    else candidates.push({ pool: p.pool, rewardsUsd, otherVotes: p.otherVotes });
    log.info("candidate", { pool: nameOf(p.pool), alive: p.alive, rewardsUsd, otherVotes: p.otherVotes, rewards: detail });
  }

  if (candidates.length === 0) throw new Error("no whitelisted pool has a live gauge");
  const vote = select(candidates, epoch.power);
  if (!vote) {
    log.warning("no pool pays anything; keeping the current vote", { currentVote: epoch.currentVote });
    return;
  }
  const names = vote.pools.map(nameOf);
  if (sameVote(epoch.currentVote, vote, epoch.power)) {
    log.info("already voted for the best pool this epoch", { pools: names });
    return;
  }
  log.info("voting", { pools: names, currentVote: epoch.currentVote, power: epoch.power });
  await castVote(chain, account, vote, dryRun, until);
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const module = getAddress(required("MODULE"));
  const keyVersion = process.env.KMS_KEY_VERSION;
  if (!keyVersion && !dryRun) throw new Error("KMS_KEY_VERSION is not set");
  const offsetFields = (process.env.VOTE_OFFSETS ?? DEFAULT_OFFSETS).split(",");
  if (!offsetFields.every((s) => /^[0-9]+$/.test(s))) throw new Error("VOTE_OFFSETS must be comma-separated seconds");
  const offsets = offsetFields.map(BigInt);
  const whitelist = (JSON.parse(readFileSync(new URL("../pools.json", import.meta.url), "utf8")) as Whitelist).map(
    (w) => ({ pool: getAddress(w.pool), name: String(w.name) }),
  );
  if (whitelist.length === 0) throw new Error("pools.json is empty");

  const chain = await connect(module, [required("BASE_RPC_URL"), process.env.FALLBACK_RPC_URL ?? PUBLIC_RPC]);
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
  const deadline = flip * 1000n - BigInt(LAST_MARGIN);
  const run: Run = { chain, whitelist, prices: priceFeed(PRICE_MAX_AGE), account, dryRun };
  try {
    run.static = await readStatic(chain, whitelist.map((w) => w.pool));
  } catch (error) {
    log.warning("static read failed; the first pass retries it", { error: describe(error) });
  }

  let failed = 0;
  for (const [i, time] of times.entries()) {
    await sleep(Number(time * 1000n - BigInt(Date.now())));
    const until = i + 1 < times.length ? times[i + 1]! * 1000n : deadline;
    if (BigInt(Date.now()) >= until) {
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
        const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && BigInt(Date.now() + RETRY_DELAY) < until;
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

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      log.error("fatal", { error: describe(error) });
      process.exit(1);
    },
  );
}

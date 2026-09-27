import { readFileSync, realpathSync } from "node:fs";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { connect, hostOf, WEEK, type Chain } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { describe, log } from "./log.ts";
import { priceFeed } from "./prices.ts";
import { readEpoch, readState, readStatic, StaticChanged, type State, type Static } from "./rewards.ts";
import { select, type Candidate } from "./select.ts";
import { castVote, VoteSent } from "./vote.ts";

// Tried in this order after the URLs in BASE_RPC_URL. Free, rate-limited nodes: Base itself says its own is "not
// suitable for production apps", so they only answer when every configured provider has failed.
const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];
const DEFAULT_OFFSETS = "86400,600,200,70,25,10,5";
const HORIZON = 3600n; // an execution runs the passes due within this many seconds
const ATTEMPTS = 3;
const RETRY_DELAY = 5_000;
const LAST_MARGIN = 2_000; // ms before the flip after which nothing is attempted
// A pass reads 3 calls, then 5 per pool, then one per reward token (about 12 per pool today). At 50 pools that is about
// 850 calls, one eth_call; and the epoch and votes, which are compared and subtracted, always fit in the first
// CHUNK (chain.ts) and so come from one block. Reward tokens beyond it go to a second call; they are only summed.
export const MAX_POOLS = 50;

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

/** pools.json: named pool addresses, at least one and at most MAX_POOLS, none twice. */
export function parseWhitelist(json: string): Whitelist {
  const whitelist = (JSON.parse(json) as Whitelist).map((w) => ({ pool: getAddress(w.pool), name: String(w.name) }));
  if (whitelist.length === 0) throw new Error("pools.json is empty");
  if (whitelist.length > MAX_POOLS) throw new Error(`pools.json lists ${whitelist.length} pools; at most ${MAX_POOLS} fit one read (see MAX_POOLS)`);
  const repeated = whitelist.filter((w, i) => whitelist.findIndex((x) => x.pool === w.pool) !== i);
  if (repeated.length) throw new Error(`pools.json lists ${repeated.map((w) => w.pool).join(", ")} more than once`);
  return whitelist;
}

const calendarEpoch = () => (now() / WEEK) * WEEK;

function assertFresh(voterStart: bigint, calendar = calendarEpoch()): void {
  if (voterStart !== calendar) throw new Error(`Voter epoch ${voterStart} is stale at ${now()}; minter not updated`);
}

type Run = {
  chain: Chain;
  whitelist: Whitelist;
  static?: Static;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

async function pass(run: Run, until: bigint): Promise<void> {
  const { chain, whitelist, prices, account, dryRun } = run;
  const start = calendarEpoch();
  const readPools = () => readStatic(chain, whitelist.map((w) => w.pool));
  run.static ??= await readPools();
  let state: State;
  try {
    state = await readState(chain, run.static, start);
  } catch (error) {
    if (!(error instanceof StaticChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.static = await readPools();
    state = await readState(chain, run.static, start);
  }
  assertFresh(state.voterStart, start);
  if (state.power === 0n) throw new Error("conduit has no voting power this epoch");
  const rewards = state.pools;
  const priced = await prices(rewards.flatMap((p) => p.rewards.map((r) => r.token)), Number(until));
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
    else candidates.push({ pool: p.pool, rewardsUsd, otherVotes: p.otherVotes });
    log.info("candidate", { pool: nameOf(p.pool), alive: p.alive, rewardsUsd, otherVotes: p.otherVotes, rewards: detail });
  }

  if (candidates.length === 0) throw new Error("no whitelisted pool has a live gauge");
  const choice = select(candidates, state.power, state.currentVote);
  if (!choice) {
    log.info("no pool pays anything; keeping the current vote", { currentVote: state.currentVote });
    return;
  }
  const { vote, expectedUsd, better } = choice;
  const plan = vote.pools.map((pool, i) => ({ pool: nameOf(pool), share: Number(vote.weights[i]) / 100 }));
  if (!better) {
    log.info("keeping the current vote", { plan, expectedUsd, currentVote: state.currentVote });
    return;
  }
  log.info("voting", { plan, expectedUsd, currentVote: state.currentVote, power: state.power });
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
  const whitelist = parseWhitelist(readFileSync(new URL("../pools.json", import.meta.url), "utf8"));

  const rpcUrls = [...new Set([...required("BASE_RPC_URL").split(","), ...PUBLIC_RPCS].map((url) => url.trim()).filter(Boolean))];
  const chain = await connect(module, rpcUrls);
  const account = keyVersion ? kmsAccount(keyVersion, chain.keeper) : undefined;
  log.info("keeper", { module, keeper: chain.keeper, conduit: chain.conduit, voter: chain.voter, rpcs: rpcUrls.map(hostOf), dryRun });

  const { start, flip } = await readEpoch(chain);
  if (!immediately && flip <= now() && now() - flip < HORIZON) {
    log.warning("restarted after the flip; nothing to do", { flip });
    return 0;
  }
  assertFresh(start);
  const { times, note } = schedule(flip, offsets, now(), immediately);
  if (note) log.warning(note, { flip });
  if (times.length === 0) return 0;
  const deadline = flip * 1000n - BigInt(LAST_MARGIN);
  const run: Run = { chain, whitelist, prices: priceFeed(), account, dryRun };
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

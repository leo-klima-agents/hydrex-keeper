import { readFileSync } from "node:fs";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { connect, WEEK, type Chain } from "./chain.ts";
import { kmsAccount } from "./kms.ts";
import { describe, log } from "./log.ts";
import { prices } from "./prices.ts";
import { readEpoch, readRewards } from "./rewards.ts";
import { select, type Candidate } from "./select.ts";
import { castVote, sameVote } from "./vote.ts";

const PUBLIC_RPC = "https://mainnet.base.org";
const ATTEMPTS = 3;
const RETRY_DELAY = 5_000;
const LAST_MARGIN = 5_000; // ms before the flip after which nothing is attempted

type Whitelist = { pool: Address; name: string }[];

const now = () => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Times (unix seconds) of the passes still ahead, earliest first. */
export function passTimes(flip: bigint, offsets: bigint[], at: bigint): bigint[] {
  return [...new Set(offsets.map((o) => flip - o))].filter((t) => t > at).sort((a, b) => (a < b ? -1 : 1));
}

async function pass(chain: Chain, whitelist: Whitelist, account: LocalAccount | undefined, dryRun: boolean): Promise<void> {
  const epoch = await readEpoch(chain);
  const t = now();
  if (epoch.start !== (t / WEEK) * WEEK) throw new Error(`Voter epoch ${epoch.start} is stale at ${t}; minter not updated`);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");

  const pools = whitelist.map((w) => w.pool);
  const rewards = await readRewards(chain, pools, epoch);
  const priced = await prices(rewards.flatMap((p) => p.rewards.map((r) => r.token)));
  const candidates: Candidate[] = [];
  for (const [i, p] of rewards.entries()) {
    const detail = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const rewardsUsd = detail.reduce((sum, d) => sum + (d.usd ?? 0), 0);
    const unpriced = detail.filter((d) => d.usd === null);
    if (unpriced.length) log.warning("unpriced rewards count as zero", { pool: whitelist[i]!.name, unpriced });
    if (!p.alive) log.warning("gauge is dead, skipping", { pool: whitelist[i]!.name });
    else candidates.push({ pool: p.pool, rewardsUsd, otherVotes: p.otherVotes });
    log.info("candidate", { pool: whitelist[i]!.name, alive: p.alive, rewardsUsd, otherVotes: p.otherVotes, rewards: detail });
  }

  const vote = select(candidates, epoch.power);
  if (!vote) {
    log.warning("no pool pays anything; keeping the current vote", { currentVote: epoch.currentVote });
    return;
  }
  const names = vote.pools.map((pool) => whitelist.find((w) => w.pool === pool)?.name ?? pool);
  if (sameVote(epoch.currentVote, vote)) {
    log.info("already voted for the best pool this epoch", { pools: names });
    return;
  }
  log.info("voting", { pools: names, currentVote: epoch.currentVote, power: epoch.power });
  await castVote(chain, account, vote, dryRun);
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const module = getAddress(required("MODULE"));
  const keyVersion = process.env.KMS_KEY_VERSION;
  if (!keyVersion && !dryRun) throw new Error("KMS_KEY_VERSION is not set");
  const offsets = (process.env.VOTE_OFFSETS ?? "3600,600,60").split(",").map((s) => BigInt(s.trim()));
  const whitelist = (JSON.parse(readFileSync(new URL("../pools.json", import.meta.url), "utf8")) as Whitelist).map(
    (w) => ({ pool: getAddress(w.pool), name: String(w.name) }),
  );
  if (whitelist.length === 0) throw new Error("pools.json is empty");

  const chain = await connect(module, [required("BASE_RPC_URL"), process.env.FALLBACK_RPC_URL ?? PUBLIC_RPC]);
  const account = keyVersion ? kmsAccount(keyVersion, chain.keeper) : undefined;
  log.info("keeper", { module, keeper: chain.keeper, conduit: chain.conduit, voter: chain.voter, dryRun });

  const { flip } = await readEpoch(chain);
  const times = immediately ? [now()] : passTimes(flip, offsets, now());
  if (times.length === 0) throw new Error(`started too late: the epoch flips at ${flip}, offsets ${offsets.join(",")}`);
  const deadline = flip * 1000n - BigInt(LAST_MARGIN);

  let failed = 0;
  for (const [i, time] of times.entries()) {
    await sleep(Number(time * 1000n - BigInt(Date.now())));
    const until = i + 1 < times.length ? times[i + 1]! * 1000n : deadline;
    log.info("pass", { at: time, flip, secondsToFlip: flip - now() });
    for (let attempt = 1; ; attempt++) {
      try {
        await pass(chain, whitelist, account, dryRun);
        break;
      } catch (error) {
        const retry = attempt < ATTEMPTS && BigInt(Date.now() + RETRY_DELAY) < until;
        log.error(`pass failed${retry ? ", retrying" : ""}`, { attempt, error: describe(error) });
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

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      log.error("fatal", { error: describe(error) });
      process.exit(1);
    },
  );
}

import { setTimeout as sleep } from "node:timers/promises";
import { formatUnits, type Address, type LocalAccount } from "viem";
import {
  byConduit,
  CONDUITS,
  otherOf,
  readMany,
  voterCall,
  type ByConduit,
  type Chain,
  type Conduit,
} from "./chain.ts";
import { decide, proportionalVote } from "./decide.ts";
import { errorMessage, log, warnOnce } from "./log.ts";
import { onchainOf, pricedPools, readValues, unscored } from "./onchain.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { readRewards, readVotes, type Epoch, type PoolRewards, type PoolVotes } from "./read.ts";
import { DAY, HORIZON } from "./schedule.ts";
import type { Vote } from "./select.ts";
import { castVote, pendingVote, votedAt, VoteSent, type Rival } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

/** `signers` sign for each conduit's key. Only a dry run goes without. */
export type Run = {
  chain: Chain;
  tokens: Whitelist;
  prices: ReturnType<typeof priceFeed>;
  signers: ByConduit<LocalAccount | undefined>;
  dryRun: boolean;
};

type Pool = PoolRewards & Partial<Pick<PoolVotes, "weight" | "votes">>;

export const tokensOf = ({ tokens }: Run) => tokens.map((t) => t.token);

export function valueRewards(run: Run, pools: Pool[], priced: Prices, verbose: boolean): number[] {
  if (priced.size === 0 && pools.length > 0) throw new Error("no whitelisted token could be priced");
  const unpriced = run.tokens.filter((t) => !priced.has(t.token.toLowerCase() as Address));
  if (verbose && unpriced.length) log.warning("unpriced tokens count as zero", { tokens: unpriced.map((t) => t.name) });
  const names = new Map(run.tokens.map((t) => [t.token, t.name]));
  return pools.map(({ pool, rewards, weight, votes }) => {
    const valued = rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: names.get(r.token) ?? r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const usd = valued.reduce((sum, r) => sum + (r.usd ?? 0), 0);
    if (verbose) log.info("pool", { pool, usd, weight, votes, rewards: valued });
    return usd;
  });
}

/** The pools with rewards, and each one's rewards in USD, logged once per read. */
export type DayBefore = { pools: PoolRewards[]; usd: number[] };

export async function readDayBefore(run: Run, until: number): Promise<DayBefore> {
  const [pools, priced] = await Promise.all([readRewards(run.chain, tokensOf(run)), run.prices(tokensOf(run), until)]);
  return { pools, usd: valueRewards(run, pools, priced, true) };
}

/**
 * Both conduits share one read per attempt, and a retry reads again. A failed read is forgotten, so the next call tries
 * again.
 */
export function perAttempt<T>(read: () => Promise<T>): (attempt: number) => Promise<T> {
  const reads = new Map<number, Promise<T>>();
  return (attempt) => {
    let reading = reads.get(attempt);
    if (!reading) {
      reading = read();
      reads.set(attempt, reading);
      reading.catch(() => reads.delete(attempt));
    }
    return reading;
  };
}

/** Anyone can vote for an open conduit, so for one of those, only a vote its key sent counts. */
export async function votedDayBefore(chain: Chain, conduit: Conduit, flip: bigint): Promise<boolean> {
  const { address } = conduit;
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [address])]);
  if (lastVoted! < flip - DAY - HORIZON) return false;
  if (conduit.open && !(await votedAt(chain, conduit, lastVoted!))) return false;
  log.info("already voted a day before the flip", { conduit: address, lastVoted });
  return true;
}

/** Which conduits vote this epoch: those with voting power. One without is warned about, and fails nothing. */
export function votingOf({ conduits }: Chain, epoch: Epoch): ByConduit<boolean> {
  const voting = byConduit((name) => epoch.votes[name].power > 0n);
  for (const name of CONDUITS) {
    const { label, address } = conduits[name];
    if (!voting[name]) log.warning(`${label} has no voting power this epoch: not voting for it`, { conduit: address });
  }
  return voting;
}

export type DayBeforeOptions = {
  /** Whether to skip a conduit whose day-before vote is already on chain, as a retry does. */
  recheck: boolean;
  /** No attempt starts after this time (ms). */
  until: number;
  /** The day-before read of each attempt, shared by the conduits. */
  read?: (attempt: number) => Promise<DayBefore>;
  pass?: typeof pass;
};

/**
 * Each voting conduit's vote a day before the flip, and how many conduits failed to vote. A conduit that checks votes
 * on chain votes after the other's vote is in or has failed, so that its check counts the votes that one moved, and its
 * vote is checked after that one too, which may still be pending. Each conduit retries on its own, and neither depends
 * on the other.
 */
export async function dayBefore(
  run: Run,
  flip: bigint,
  voting: ByConduit<boolean>,
  { recheck, until, read, pass: passWith = pass }: DayBeforeOptions,
): Promise<number> {
  const { chain, dryRun } = run;
  const { conduits } = chain;
  const reads = read ?? perAttempt(() => readDayBefore(run, until));
  const passed: Partial<ByConduit<Vote>> = {};
  const rivalOf = async ({ name, checks }: Conduit): Promise<Rival | undefined> => {
    if (!checks) return undefined;
    const other = conduits[otherOf(name)];
    const vote = dryRun ? passed[other.name] : await pendingVote(chain, other);
    return vote && { conduit: other, vote };
  };
  const order = [...CONDUITS].sort((a, b) => Number(conduits[a].checks) - Number(conduits[b].checks));
  let failures = 0;
  for (const name of order) {
    if (!voting[name]) continue;
    const conduit = conduits[name];
    const attempt = async (n: number) => {
      if (recheck && (await votedDayBefore(chain, conduit, flip))) return;
      const vote = await passWith(run, conduit, await reads(n), until, await rivalOf(conduit));
      if (vote) passed[name] = vote;
    };
    if (!(await attempts(`${name} pass`, attempt, until))) failures++;
  }
  return failures;
}

/** Runs `pass` until it succeeds, up to ATTEMPTS times, while a retry can start before `until` (ms). */
export async function attempts(
  name: string,
  pass: (attempt: number) => Promise<void>,
  until: number,
): Promise<boolean> {
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

/**
 * The conduit's vote a day before the flip, in proportion to each pool's rewards. A conduit that checks votes on chain
 * only takes one that clears its check, after `rival` too, the other conduit's vote, while that one may still land.
 */
export async function pass(
  run: Run,
  conduit: Conduit,
  { pools, usd }: DayBefore,
  until: number,
  rival?: Rival,
): Promise<Vote | undefined> {
  const { chain } = run;
  const { name, address } = conduit;
  const decision = conduit.checks ? await checked(chain, conduit, pools, usd) : proportionalVote(name, pools, usd);
  const { vote, note, summary } = decision;
  if (!vote) {
    log.info(note, { conduit: address, ...summary });
    return undefined;
  }
  log.info("vote", { conduit: address, ...summary });
  await castVote(chain, conduit, run.signers[name], vote, run.dryRun, until, rival);
  return vote;
}

/** A checking conduit's vote, which must clear its check: that counts the votes in force, read with its values. */
async function checked(chain: Chain, conduit: Conduit, pools: PoolRewards[], usd: number[]) {
  const { name, address, label, priced } = conduit;
  const valuesUnread = warnOnce(`${label}'s values unread; its simulation checks the vote`, { conduit: address });
  const [state, values] = await Promise.all([
    readVotes(chain, pools),
    readValues(conduit, chain.bulk, pricedPools(pools, priced)).catch(valuesUnread),
  ]);
  if (state.scores[name] === undefined) unscored(conduit)(new Error("currentScore reverted"));
  return decide(name, state, usd, { onchain: onchainOf(state, name, values), proportionally: true });
}

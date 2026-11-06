import { formatUnits, type Address, type LocalAccount } from "viem";
import { readMany, voterCall, type Chain, type Conduit, type ByConduit } from "./chain.ts";
import { onchainOf, pricedPools, readValues, unscored } from "./check.ts";
import { decide } from "./decide.ts";
import { log, warnOnce } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { readRewards, readVotes, type PoolRewards, type PoolVotes } from "./read.ts";
import { DAY, HORIZON } from "./schedule.ts";
import type { Vote } from "./select.ts";
import { castVote, votedAt, type Rival } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

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

/** The pools with rewards, the prices, and each pool's rewards in USD, logged once per read. */
export type DayBefore = { pools: PoolRewards[]; priced: Prices; usd: number[] };

export async function readDayBefore(run: Run, until: number): Promise<DayBefore> {
  const [pools, priced] = await Promise.all([readRewards(run.chain, tokensOf(run)), run.prices(tokensOf(run), until)]);
  return { pools, priced, usd: valueRewards(run, pools, priced, true) };
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
  const { name, address, priced } = conduit;
  const valuesUnread = warnOnce(`${conduit.label}'s values unread; its simulation checks the vote`, {
    conduit: address,
  });
  const [state, values] = await Promise.all([
    readVotes(chain, pools),
    priced ? readValues(conduit, chain.bulk, pricedPools(pools, priced)).catch(valuesUnread) : undefined,
  ]);
  if (priced && state.scores[name] === undefined) unscored(conduit)(new Error("currentScore reverted"));
  const onchain = priced ? onchainOf(state, name, values) : undefined;
  const { vote, note, summary } = decide(name, state, usd, { onchain, proportionally: true });
  if (!vote) {
    log.info(note, { conduit: address, ...summary });
    return undefined;
  }
  log.info("vote", { conduit: address, ...summary });
  await castVote(chain, conduit, run.signers[name], vote, run.dryRun, until, rival);
  return vote;
}

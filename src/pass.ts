import { formatUnits, type Address, type LocalAccount } from "viem";
import { readMany, voterCall, type Chain } from "./chain.ts";
import { decideV2, pricedPools, readScore, readValues } from "./immutable.ts";
import { log, warnOnce } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { readRewards, readVotes, type PoolRewards } from "./read.ts";
import { DAY, HORIZON } from "./schedule.ts";
import { proportional, toVote, type Vote } from "./select.ts";
import { castVote, klimaSender, pendingVote, v2Sender, votedAt, type Sender } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

export type Run = {
  chain: Chain;
  tokens: Whitelist;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  proposer?: LocalAccount | undefined;
  dryRun: boolean;
};

type Pool = PoolRewards & { otherVotes?: bigint; ownVotes?: bigint; v2Votes?: bigint };

export const tokensOf = ({ tokens }: Run) => tokens.map((t) => t.token);

export function valueRewards(run: Run, pools: Pool[], priced: Prices, verbose: boolean): number[] {
  if (priced.size === 0 && pools.length > 0) throw new Error("no whitelisted token could be priced");
  const unpriced = run.tokens.filter((t) => !priced.has(t.token.toLowerCase() as Address));
  if (verbose && unpriced.length) log.warning("unpriced tokens count as zero", { tokens: unpriced.map((t) => t.name) });
  const names = new Map(run.tokens.map((t) => [t.token, t.name]));
  return pools.map(({ pool, rewards, otherVotes, ownVotes, v2Votes }) => {
    const valued = rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: names.get(r.token) ?? r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const usd = valued.reduce((sum, r) => sum + (r.usd ?? 0), 0);
    if (verbose) log.info("pool", { pool, usd, otherVotes, ownVotes, v2Votes, rewards: valued });
    return usd;
  });
}

export type DayBefore = { pools: PoolRewards[]; priced: Prices };

export async function readDayBefore(run: Run, until: number): Promise<DayBefore> {
  const [pools, priced] = await Promise.all([readRewards(run.chain, tokensOf(run)), run.prices(tokensOf(run), until)]);
  return { pools, priced };
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

/** Anyone can vote for an open conduit, so for one of those, only a vote the sender sent counts. */
export async function votedDayBefore(chain: Chain, sender: Sender, flip: bigint): Promise<boolean> {
  const { conduit } = sender;
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [conduit])]);
  if (lastVoted! < flip - DAY - HORIZON) return false;
  if (sender.open && !(await votedAt(chain, sender, lastVoted!))) return false;
  log.info("already voted a day before the flip", { conduit, lastVoted });
  return true;
}

export async function pass(run: Run, { pools, priced }: DayBefore, until: number): Promise<Vote | undefined> {
  const fractions = proportional(valueRewards(run, pools, priced, true));
  if (!fractions) {
    log.info("no pool pays anything; keeping the current vote");
    return undefined;
  }
  const vote = toVote(pools, fractions);
  await castVote(run.chain, run.account, vote, run.dryRun, until);
  return vote;
}

/**
 * While the Klima conduit's vote may still land, this vote must also pass the check after it. In a dry run, that vote
 * is `klima`.
 */
export async function passV2(run: Run, { pools, priced }: DayBefore, until: number, klima?: Vote): Promise<void> {
  const { chain } = run;
  const { conduit, priced: tokens } = chain.v2!;
  const [state, values, current] = await Promise.all([
    readVotes(chain, pools),
    readValues(chain, chain.bulk, pricedPools(pools, tokens)).catch(
      warnOnce("v2's values unread; its simulation checks the vote", { conduit }),
    ),
    readScore(chain, chain.bulk).catch(warnOnce("v2's score unread; its simulation checks the vote", { conduit })),
  ]);
  const onchain = values && current !== undefined ? { values, current } : undefined;
  const { vote, note, summary } = decideV2(state, valueRewards(run, state.pools, priced, false), onchain, true);
  if (!vote) return log.info(note, { conduit, ...summary });
  log.info("v2 vote", { conduit, ...summary });
  const keeper = klimaSender(chain);
  const landing = run.dryRun ? klima : await pendingVote(chain, keeper);
  const rival = landing && { sender: keeper, vote: landing };
  await castVote(chain, run.proposer, vote, run.dryRun, until, v2Sender(chain), rival);
}

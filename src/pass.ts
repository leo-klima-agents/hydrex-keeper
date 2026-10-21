import { formatUnits, type Address, type LocalAccount } from "viem";
import type { Chain } from "./chain.ts";
import { decideV2, pricedPools, readScore, readValues } from "./immutable.ts";
import { log, warnOnce } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { readRewards, readVotes, type PoolRewards } from "./read.ts";
import { proportional, toVote, type Vote } from "./select.ts";
import { castVote, klimaSender, v2Sender, VoteSent } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

export type Run = {
  chain: Chain;
  tokens: Whitelist;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  /** Signs the immutable conduit's votes, if the job votes for it. */
  proposer?: LocalAccount | undefined;
  dryRun: boolean;
};

type Pool = PoolRewards & { otherVotes?: bigint; ownVotes?: bigint; v2Votes?: bigint };

export const tokensOf = ({ tokens }: Run) => tokens.map((t) => t.token);

/** Each pool's rewards in USD; unpriced tokens count as zero. Logs each pool if `verbose`. */
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

/** What both conduits' votes a day before the flip are made from. */
export type DayBefore = { pools: PoolRewards[]; priced: Prices };

/** The rewards and their prices, which both conduits' votes a day before the flip are made from. */
export async function readDayBefore(run: Run, until: number): Promise<DayBefore> {
  const [pools, priced] = await Promise.all([readRewards(run.chain, tokensOf(run)), run.prices(tokensOf(run), until)]);
  return { pools, priced };
}

/**
 * `read` once for each round of attempts, which both conduits share, so that a retry reads again; a read that fails is
 * read again by the next call.
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

/**
 * The Klima conduit's vote a day before the flip, in proportion to each pool's rewards. `sent` gets it once cast, or
 * once it failed after it was sent: either way, it may still be pending.
 */
export async function pass(
  run: Run,
  { pools, priced }: DayBefore,
  until: number,
  sent: (vote: Vote) => void,
): Promise<void> {
  const fractions = proportional(valueRewards(run, pools, priced, true));
  if (!fractions) return log.info("no pool pays anything; keeping the current vote");
  const vote = toVote(pools, fractions);
  try {
    await castVote(run.chain, run.account, vote, run.dryRun, until);
  } catch (error) {
    if (error instanceof VoteSent) sent(vote);
    throw error;
  }
  sent(vote);
}

/**
 * The immutable conduit's vote a day before the flip, in proportion to each pool's rewards, if it clears its check,
 * after `klima`, the Klima conduit's vote of the same pass, too: that one may still be pending. When the conduit's own
 * values cannot be read, the simulation checks it.
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
  const rival = klima && { sender: klimaSender(chain), vote: klima };
  await castVote(chain, run.proposer, vote, run.dryRun, until, v2Sender(chain), rival);
}

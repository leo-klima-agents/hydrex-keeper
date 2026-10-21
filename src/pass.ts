import { formatUnits, type Address, type LocalAccount } from "viem";
import type { Chain } from "./chain.ts";
import { decideV2, pricedPools, readScore, readValues } from "./immutable.ts";
import { errorMessage, log } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { readRewards, readVotes, type PoolRewards } from "./read.ts";
import { proportional, toVote } from "./select.ts";
import { castVote, v2Sender } from "./vote.ts";
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

type Pool = PoolRewards & { otherVotes?: bigint; ownVotes?: bigint };

export const tokensOf = ({ tokens }: Run) => tokens.map((t) => t.token);

/** Each pool's rewards in USD; unpriced tokens count as zero. Logs each pool if `verbose`. */
export function valueRewards(run: Run, pools: Pool[], priced: Prices, verbose: boolean): number[] {
  if (priced.size === 0 && pools.length > 0) throw new Error("no whitelisted token could be priced");
  const unpriced = run.tokens.filter((t) => !priced.has(t.token.toLowerCase() as Address));
  if (verbose && unpriced.length) log.warning("unpriced tokens count as zero", { tokens: unpriced.map((t) => t.name) });
  const names = new Map(run.tokens.map((t) => [t.token, t.name]));
  return pools.map(({ pool, rewards, otherVotes, ownVotes }) => {
    const valued = rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: names.get(r.token) ?? r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const usd = valued.reduce((sum, r) => sum + (r.usd ?? 0), 0);
    if (verbose) log.info("pool", { pool, usd, otherVotes, ownVotes, rewards: valued });
    return usd;
  });
}

/** What both conduits' votes a day before the flip are made from. */
export type DayBefore = { pools: PoolRewards[]; priced: Prices };

/** Reads the rewards and their prices once for both conduits; after a failure, the next call reads them again. */
export function dayBeforeReads(run: Run, until: number): () => Promise<DayBefore> {
  let reads: Promise<DayBefore> | undefined;
  const read = async () => {
    const [pools, priced] = await Promise.all([
      readRewards(run.chain, tokensOf(run)),
      run.prices(tokensOf(run), until),
    ]);
    return { pools, priced };
  };
  return () =>
    (reads ??= read().catch((error: unknown) => {
      reads = undefined;
      throw error;
    }));
}

/** The Klima conduit's vote a day before the flip, in proportion to each pool's rewards. */
export async function pass(run: Run, { pools, priced }: DayBefore, until: number): Promise<void> {
  const fractions = proportional(valueRewards(run, pools, priced, true));
  if (!fractions) return log.info("no pool pays anything; keeping the current vote");
  await castVote(run.chain, run.account, toVote(pools, fractions), run.dryRun, until);
}

/**
 * The immutable conduit's vote a day before the flip, in proportion to each pool's rewards, if it clears its check.
 * When the conduit's own values cannot be read, the simulation checks it.
 */
export async function passV2(run: Run, { pools, priced }: DayBefore, until: number): Promise<void> {
  const { chain } = run;
  const { conduit, priced: tokens } = chain.v2!;
  const unread = (error: unknown) => {
    log.warning("v2's own values unread; its simulation checks the vote", { conduit, error: errorMessage(error) });
    return undefined;
  };
  const [state, values, current] = await Promise.all([
    readVotes(chain, pools),
    readValues(chain, chain.bulk, pricedPools(pools, tokens)).catch(unread),
    readScore(chain, chain.bulk).catch(unread),
  ]);
  const onchain = values && current !== undefined ? { values, current } : undefined;
  const { vote, note, summary } = decideV2(state, valueRewards(run, state.pools, priced, false), onchain, true);
  if (!vote) return log.info(note, { conduit, ...summary });
  log.info("v2 vote", { conduit, ...summary });
  await castVote(chain, run.proposer, vote, run.dryRun, until, v2Sender(chain));
}

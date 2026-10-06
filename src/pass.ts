import { formatUnits, type Address, type LocalAccount } from "viem";
import type { Chain } from "./chain.ts";
import { log } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { readRewards, type PoolRewards } from "./read.ts";
import { proportional, toVote } from "./select.ts";
import { castVote } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

export type Run = {
  chain: Chain;
  tokens: Whitelist;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
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

/** The vote a day before the flip, in proportion to each pool's rewards. */
export async function pass(run: Run, until: number): Promise<void> {
  const pools = await readRewards(run.chain, tokensOf(run));
  const fractions = proportional(valueRewards(run, pools, await run.prices(tokensOf(run), until), true));
  if (!fractions) return log.info("no pool pays anything; keeping the current vote");
  await castVote(run.chain, run.account, toVote(pools, fractions), run.dryRun, until);
}

import { formatUnits, type Address, type LocalAccount } from "viem";
import type { Chain } from "./chain.ts";
import { log } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { assertFresh, readRewards, readVotes, type State } from "./read.ts";
import { expected, proportional, select, type Strategy } from "./select.ts";
import { castVote } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

export type Run = {
  chain: Chain;
  tokens: Whitelist;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

export const tokensOf = ({ tokens }: Run) => tokens.map((t) => t.token);

/** The vote `strategy` picks, or null to keep the current one. Logs each pool if `verbose`. */
export function decide(run: Run, { epoch, pools }: State, priced: Prices, strategy: Strategy, verbose: boolean) {
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");
  if (priced.size === 0 && pools.length > 0) throw new Error("no whitelisted token could be priced");
  const unpriced = run.tokens.filter((t) => !priced.has(t.token.toLowerCase() as Address));
  if (verbose && unpriced.length) log.warning("unpriced tokens count as zero", { tokens: unpriced.map((t) => t.name) });
  const names = new Map(run.tokens.map((t) => [t.token, t.name]));
  const candidates = pools.map((p) => {
    const rewards = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: names.get(r.token) ?? r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const rewardsUsd = rewards.reduce((sum, r) => sum + (r.usd ?? 0), 0);
    const candidate = { pool: p.pool, rewardsUsd, otherVotes: p.otherVotes, ownVotes: p.ownVotes };
    if (verbose) log.info("candidate", { ...candidate, rewards });
    return candidate;
  });

  const { fractions, vote } = select(candidates, epoch.power, strategy);
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: candidates[i]!.pool, share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = pools.filter((p) => p.ownVotes > 0n).map((p) => ({ pool: p.pool, votes: p.ownVotes }));
  const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
  return { vote, reason, summary: { plan, expectedUsd, currentVote, power: epoch.power } };
}

/** The vote a day before the flip, in proportion to each pool's rewards. */
export async function pass(run: Run, until: number): Promise<void> {
  const state = await readVotes(run.chain, await readRewards(run.chain, tokensOf(run)));
  const { vote, reason, summary } = decide(run, state, await run.prices(tokensOf(run), until), proportional, true);
  if (!vote) {
    log.info(reason, summary);
    return;
  }
  log.info("voting", summary);
  await castVote(run.chain, run.account, vote, run.dryRun, until);
}

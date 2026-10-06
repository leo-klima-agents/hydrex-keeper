import { formatUnits, type Address, type LocalAccount } from "viem";
import type { Chain } from "./chain.ts";
import { log } from "./log.ts";
import type { priceFeed, Prices } from "./prices.ts";
import { assertFresh, LayoutChanged, readLayout, readPass, type Layout } from "./read.ts";
import { expected, select, type Candidate } from "./select.ts";
import { castVote } from "./vote.ts";
import type { Whitelist } from "./whitelist.ts";

export type Run = {
  chain: Chain;
  whitelist: Whitelist;
  layout?: Layout;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

type State = Awaited<ReturnType<typeof readPass>>;

const tokensOf = ({ rewards }: State) => rewards.flatMap((p) => p.rewards.map((r) => r.token));

const nameOf = ({ whitelist }: Run, pool: Address) => whitelist.find((w) => w.pool === pool)?.name ?? pool;

export async function readState(run: Run, blockTag?: "pending"): Promise<State> {
  const { chain, whitelist } = run;
  const pools = whitelist.map((w) => w.pool);
  run.layout ??= await readLayout(chain, pools, blockTag);
  try {
    return await readPass(chain, run.layout, blockTag);
  } catch (error) {
    if (!(error instanceof LayoutChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.layout = await readLayout(chain, pools, blockTag);
    return readPass(chain, run.layout, blockTag);
  }
}

/** The vote that maximises the expected reward, or null to keep the current one. Logs each pool if `verbose`. */
export function decide(run: Run, state: State, priced: Prices, verbose: boolean) {
  const { epoch, rewards } = state;
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");
  if (priced.size === 0 && tokensOf(state).length > 0) throw new Error("no reward token could be priced");
  const candidates: Candidate[] = [];
  for (const p of rewards) {
    const pool = nameOf(run, p.pool);
    const detail = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const unpriced = detail.filter((d) => d.usd === null);
    if (verbose && unpriced.length) log.warning("unpriced rewards count as zero", { pool, unpriced });
    const rewardsUsd = detail.reduce((sum, d) => sum + (d.usd ?? 0), 0);
    const candidate = { pool: p.pool, rewardsUsd, otherVotes: p.otherVotes, ownVotes: p.ownVotes };
    if (p.alive) candidates.push(candidate);
    else if (verbose) log.warning("gauge is dead, skipping", { pool });
    if (verbose) log.info("candidate", { ...candidate, pool, alive: p.alive, rewards: detail });
  }

  if (candidates.length === 0) throw new Error("no whitelisted pool has a live gauge");
  const { fractions, vote } = select(candidates, epoch.power);
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: nameOf(run, candidates[i]!.pool), share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = rewards
    .filter((p) => p.ownVotes > 0n)
    .map((p) => ({ pool: nameOf(run, p.pool), votes: p.ownVotes }));
  const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
  return { vote, reason, summary: { plan, expectedUsd, currentVote, power: epoch.power } };
}

export async function pass(run: Run, until: number): Promise<void> {
  const state = await readState(run);
  const { vote, reason, summary } = decide(run, state, await run.prices(tokensOf(state), until), true);
  if (!vote) {
    log.info(reason, summary);
    return;
  }
  log.info("voting", summary);
  await castVote(run.chain, run.account, vote, run.dryRun, until);
}

import type { Address } from "viem";
import { call, lower, readMany, type Client, type Conduit, type ConduitName } from "./chain.ts";
import { warnOnce } from "./log.ts";
import type { PoolRewards, State } from "./read.ts";
import { asVoted, gain, MIN_GAIN_USD, score, waterFillAbove, type Candidate } from "./select.ts";

// A conduit that checks votes on chain, as the immutable conduit does, lets anyone propose its vote. It only takes a vote
// whose score, counted in the tokens it prices with Chainlink, beats the vote in force by MIN_GAIN. The job picks votes
// at its own prices and checks the conduit's score before sending.
const MIN_GAIN = 1; // USD, the conduit's MIN_GAIN
const MARGIN = 0.1; // USD above MIN_GAIN, in case other votes move before ours lands
const VALUE_CHUNK = 25; // poolValue calls per eth_call, because each can use 200k gas
const VALUE_CONCURRENCY = 3; // kept low because these reads repeat every block, on the RPCs the votes use

/** The conduit's values of the pools, and its score of the vote in force, in USD. */
export type Onchain = { values: Map<Address, number>; current: number };

const usd = (wad: bigint) => Number(wad) / 1e18;

export function pricedPools(pools: PoolRewards[], priced: Address[]): Address[] {
  const tokens = new Set(priced.map(lower));
  return pools.filter((p) => p.rewards.some((r) => tokens.has(lower(r.token)))).map((p) => p.pool);
}

/** Fails while the conduit can't vote. */
export async function readValues(
  { address, abi }: Conduit,
  client: Client,
  pools: Address[],
): Promise<Map<Address, number>> {
  const calls = pools.map((pool) => call(address, abi, "poolValue", [pool]));
  const values = await readMany<bigint>(client, calls, { chunk: VALUE_CHUNK, concurrency: VALUE_CONCURRENCY });
  return new Map(pools.map((pool, i) => [lower(pool), usd(values[i]!)]));
}

/** For a score the conduit couldn't give with the votes: warns once per run of the function it returns. */
export const unscored = ({ label, address }: Conduit) =>
  warnOnce(`${label} can't score its vote in force; its simulation checks the vote`, { conduit: address });

/** The conduit's check at `values`, with its score of the vote in force as read with the votes, if it could score. */
export function onchainOf(state: State, name: ConduitName, values: Map<Address, number> | undefined) {
  const current = state.scores[name];
  return values && current !== undefined ? { values, current: usd(current) } : undefined;
}

/**
 * The fractions `x`, or if they wouldn't beat the vote in force by MIN_GAIN plus MARGIN at the conduit's own values, the
 * best that do, as long as those still gain more than MIN_GAIN_USD. Unlike a proportional vote, the replacement must gain
 * as much as a last-block vote would, so `proportionally` starts it from the plain water-filling.
 */
export function clearCheck(
  candidates: Candidate[],
  x: number[],
  power: bigint,
  { values: byPool, current }: Onchain,
  maxPools: number,
  proportionally: boolean,
): { x: number[]; checked: { bar: number; score: number } } | { note: string; bar: number } {
  const values = candidates.map((c) => byPool.get(lower(c.pool)) ?? 0);
  const bar = current + MIN_GAIN + MARGIN;
  if (score(candidates, values, asVoted(x), power) < bar) {
    const best = waterFillAbove(candidates, power, values, bar, maxPools, proportionally ? undefined : x);
    if (!best) return { note: "no vote clears the conduit's check; keeping the vote in force", bar };
    if (gain(candidates, best, power) <= MIN_GAIN_USD) {
      return { note: "no vote that clears the conduit's check gains enough; keeping the vote in force", bar };
    }
    x = best;
  }
  return { x, checked: { bar, score: score(candidates, values, asVoted(x), power) } };
}

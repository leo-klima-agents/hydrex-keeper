import { erc20Abi, zeroAddress, type Address } from "viem";
import { bribeAbi, veAbi } from "./abi.ts";
import { now, readMany, voterCall, WEEK, type Call, type Chain } from "./chain.ts";
import { log } from "./log.ts";

export type Epoch = { start: bigint; flip: bigint; power: bigint; votedThisEpoch: boolean };

type Reward = { token: Address; amount: bigint; decimals: number };

type PoolRewards = { pool: Address; alive: boolean; otherVotes: bigint; ownVotes: bigint; rewards: Reward[] };

type Slot = { pool: number; bribe: Address; token: Address; decimals: number };

/** What rarely changes within an epoch: gauges, bribe contracts, their reward tokens. */
export type Layout = { pools: Address[]; gauges: Address[]; bribes: Address[]; lengths: bigint[]; slots: Slot[] };

/** A bribe contract gained a reward token since `readLayout`. */
export class LayoutChanged extends Error {}

const calendarEpoch = () => (now() / WEEK) * WEEK;

function bribeCall(address: Address, functionName: string, args: readonly unknown[] = []): Call {
  return { address, abi: bribeAbi, functionName, args };
}

/** The Voter's epoch, and the conduit's power at the calendar epoch start, which `assertFresh` checks is the same. */
export async function readEpoch(chain: Chain): Promise<Epoch> {
  const { client, ve, conduit } = chain;
  const [start, lastVoted, power] = (await readMany<bigint>(client, [
    voterCall(chain, "_epochTimestamp"),
    voterCall(chain, "lastVoted", [conduit]),
    { address: ve, abi: veAbi, functionName: "getPastVotes", args: [conduit, calendarEpoch()] },
  ])) as [bigint, bigint, bigint];
  return { start, flip: start + WEEK, power, votedThisEpoch: lastVoted >= start };
}

export function assertFresh(epoch: Epoch): void {
  if (epoch.start !== calendarEpoch()) {
    throw new Error(`Voter epoch ${epoch.start} is stale at ${now()}; minter not updated`);
  }
}

export async function readLayout(chain: Chain, whitelist: Address[]): Promise<Layout> {
  const { client } = chain;
  const allGauges = await readMany<Address>(
    client,
    whitelist.map((pool) => voterCall(chain, "gauges", [pool])),
  );
  const missing = whitelist.filter((_, i) => allGauges[i] === zeroAddress);
  if (missing.length) log.warning("no gauge, skipping", { pools: missing });
  const pools = whitelist.filter((_, i) => allGauges[i] !== zeroAddress);
  const gauges = allGauges.filter((gauge) => gauge !== zeroAddress);

  const bribes = await readMany<Address>(
    client,
    gauges.flatMap((gauge) => [
      voterCall(chain, "external_bribes", [gauge]),
      voterCall(chain, "internal_bribes", [gauge]),
    ]),
  );
  const lengths = await readMany<bigint>(
    client,
    bribes.map((bribe) => bribeCall(bribe, "rewardsListLength")),
  );
  const slots = bribes.flatMap((bribe, b) =>
    Array.from({ length: Number(lengths[b]) }, (_, j) => ({ pool: b >> 1, bribe, index: BigInt(j) })),
  );
  const tokens = await readMany<Address>(
    client,
    slots.map((s) => bribeCall(s.bribe, "rewardTokens", [s.index])),
  );
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  const decimals = await readMany<number | undefined>(
    client,
    distinct.map((address) => ({ address, abi: erc20Abi, functionName: "decimals" })),
    { lenient: true },
  );
  const decimalsOf = new Map(distinct.map((t, i) => [t, decimals[i] ?? 18]));
  const withTokens = slots.map(({ pool, bribe }, k) => {
    const token = tokens[k]!;
    return { pool, bribe, token, decimals: decimalsOf.get(token.toLowerCase() as Address)! };
  });
  return { pools, gauges, bribes, lengths, slots: withTokens };
}

/** This epoch's bribes and fees and the votes of each pool. */
export async function readRewards(
  chain: Chain,
  { pools, gauges, bribes, lengths, slots }: Layout,
  epoch: Epoch,
): Promise<PoolRewards[]> {
  const results = await readMany<boolean | bigint | [bigint, bigint, bigint]>(chain.client, [
    ...bribes.map((bribe) => bribeCall(bribe, "rewardsListLength")),
    ...gauges.flatMap((gauge, i) => [
      voterCall(chain, "isAlive", [gauge]),
      voterCall(chain, "weights", [pools[i]]),
      voterCall(chain, "votes", [chain.conduit, pools[i]]),
    ]),
    ...slots.map((s) => bribeCall(s.bribe, "rewardData", [s.token, epoch.start])),
  ]);
  if (lengths.some((length, b) => results[b] !== length)) throw new LayoutChanged("reward tokens changed");
  const perPool = results.slice(bribes.length, bribes.length + 3 * pools.length);
  const data = results.slice(bribes.length + 3 * pools.length) as [bigint, bigint, bigint][];

  return pools.map((pool, i) => {
    // Voter.votes keeps last epoch's vote until the next vote resets it.
    const ownVotes = epoch.votedThisEpoch ? (perPool[3 * i + 2] as bigint) : 0n;
    return {
      pool,
      alive: perPool[3 * i] as boolean,
      otherVotes: (perPool[3 * i + 1] as bigint) - ownVotes,
      ownVotes,
      rewards: slots.flatMap((s, k) =>
        s.pool === i && data[k]![1] > 0n ? [{ token: s.token, amount: data[k]![1], decimals: s.decimals }] : [],
      ),
    };
  });
}

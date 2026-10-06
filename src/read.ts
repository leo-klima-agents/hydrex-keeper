import { erc20Abi, zeroAddress, type Address } from "viem";
import { bribeAbi, veAbi } from "./abi.ts";
import { now, readMany, voterCall, WEEK, type Call, type Chain } from "./chain.ts";
import { log } from "./log.ts";

export type Epoch = { start: bigint; flip: bigint; power: bigint; lastVoted: bigint; votedThisEpoch: boolean };

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

function epochCalls(chain: Chain, calendar: bigint): Call[] {
  const { ve, conduit } = chain;
  return [
    voterCall(chain, "_epochTimestamp"),
    voterCall(chain, "lastVoted", [conduit]),
    { address: ve, abi: veAbi, functionName: "getPastVotes", args: [conduit, calendar] },
  ];
}

function toEpoch([start, lastVoted, power]: bigint[]): Epoch {
  return {
    start: start!,
    flip: start! + WEEK,
    power: power!,
    lastVoted: lastVoted!,
    votedThisEpoch: lastVoted! >= start!,
  };
}

/** The Voter's epoch, and the conduit's power at the calendar epoch start, which `assertFresh` checks is the same. */
export async function readEpoch(chain: Chain): Promise<Epoch> {
  return toEpoch(await readMany<bigint>(chain.client, epochCalls(chain, calendarEpoch())));
}

export function assertFresh(epoch: Epoch): void {
  if (epoch.start !== calendarEpoch()) {
    throw new Error(`Voter epoch ${epoch.start} is stale at ${now()}; minter not updated`);
  }
}

export async function readLayout(chain: Chain, whitelist: Address[], blockTag?: "pending"): Promise<Layout> {
  const read = <T>(calls: Call[], lenient = false) => readMany<T>(chain.client, calls, { blockTag, lenient });
  const allGauges = await read<Address>(whitelist.map((pool) => voterCall(chain, "gauges", [pool])));
  const missing = whitelist.filter((_, i) => allGauges[i] === zeroAddress);
  if (missing.length) log.warning("no gauge, skipping", { pools: missing });
  const pools = whitelist.filter((_, i) => allGauges[i] !== zeroAddress);
  const gauges = allGauges.filter((gauge) => gauge !== zeroAddress);

  const bribes = await read<Address>(
    gauges.flatMap((gauge) => [
      voterCall(chain, "external_bribes", [gauge]),
      voterCall(chain, "internal_bribes", [gauge]),
    ]),
  );
  const lengths = await read<bigint>(bribes.map((bribe) => bribeCall(bribe, "rewardsListLength")));
  const slots = bribes.flatMap((bribe, b) =>
    Array.from({ length: Number(lengths[b]) }, (_, j) => ({ pool: b >> 1, bribe, index: BigInt(j) })),
  );
  const tokens = await read<Address>(slots.map((s) => bribeCall(s.bribe, "rewardTokens", [s.index])));
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  const decimals = await read<number | undefined>(
    distinct.map((address) => ({ address, abi: erc20Abi, functionName: "decimals" })),
    true,
  );
  const decimalsOf = new Map(distinct.map((t, i) => [t, decimals[i] ?? 18]));
  const withTokens = slots.map(({ pool, bribe }, k) => {
    const token = tokens[k]!;
    return { pool, bribe, token, decimals: decimalsOf.get(token.toLowerCase() as Address)! };
  });
  return { pools, gauges, bribes, lengths, slots: withTokens };
}

/**
 * A pass's one read: the epoch, as `readEpoch`, and each pool's liveness, votes, and bribes and fees this epoch. The
 * epoch and votes come first, so that for up to 199 pools they come from one eth_call, and so from one block.
 * `pending` reads the block being built.
 */
export async function readPass(
  chain: Chain,
  { pools, gauges, bribes, lengths, slots }: Layout,
  blockTag?: "pending",
): Promise<{ epoch: Epoch; rewards: PoolRewards[] }> {
  const calendar = calendarEpoch();
  const results = await readMany<boolean | bigint | [bigint, bigint, bigint]>(
    chain.client,
    [
      ...epochCalls(chain, calendar),
      ...bribes.map((bribe) => bribeCall(bribe, "rewardsListLength")),
      ...gauges.flatMap((gauge, i) => [
        voterCall(chain, "isAlive", [gauge]),
        voterCall(chain, "weights", [pools[i]]),
        voterCall(chain, "votes", [chain.conduit, pools[i]]),
      ]),
      ...slots.map((s) => bribeCall(s.bribe, "rewardData", [s.token, calendar])),
    ],
    { blockTag },
  );
  const epoch = toEpoch(results.slice(0, 3) as bigint[]);
  if (lengths.some((length, b) => results[3 + b] !== length)) throw new LayoutChanged("reward tokens changed");
  const perPool = results.slice(3 + bribes.length, 3 + bribes.length + 3 * pools.length);
  const data = results.slice(3 + bribes.length + 3 * pools.length) as [bigint, bigint, bigint][];

  const rewards = pools.map((pool, i) => {
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
  return { epoch, rewards };
}

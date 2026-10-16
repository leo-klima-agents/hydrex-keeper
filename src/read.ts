import { erc20Abi, type Address } from "viem";
import { bribeAbi, veAbi } from "./abi.ts";
import { lower, now, readMany, voterCall, WEEK, type Call, type Chain, type Client } from "./chain.ts";

export type Epoch = { start: bigint; flip: bigint; power: bigint; lastVoted: bigint; votedThisEpoch: boolean };

type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; rewards: Reward[] };

export type State = { epoch: Epoch; pools: (PoolRewards & { otherVotes: bigint; ownVotes: bigint })[] };

const calendarEpoch = () => (now() / WEEK) * WEEK;

export function bribeCall(address: Address, functionName: string, args: readonly unknown[] = []): Call {
  return { address, abi: bribeAbi, functionName, args };
}

const decimalsCall = (address: Address): Call => ({ address, abi: erc20Abi, functionName: "decimals" });

export async function readDecimals(client: Client, tokens: Address[]): Promise<Map<string, number>> {
  const decimals = await readMany<number>(client, tokens.map(decimalsCall));
  return new Map(tokens.map((token, i) => [lower(token), decimals[i]!]));
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

export type Reader = <T>(calls: Call[]) => Promise<T[]>;

export type Bribe = { pool: Address; bribe: Address; fees: boolean; alive: boolean };

export async function readBribes(chain: Chain, read: Reader): Promise<Bribe[]> {
  const [count] = await read<bigint>([voterCall(chain, "length")]);
  const pools = await read<Address>(
    Array.from({ length: Number(count) }, (_, i) => voterCall(chain, "pools", [BigInt(i)])),
  );
  const gauges = await read<Address>(pools.map((pool) => voterCall(chain, "gauges", [pool])));
  const perGauge = await read<boolean | Address>(
    gauges.flatMap((gauge) => [
      voterCall(chain, "isAlive", [gauge]),
      voterCall(chain, "external_bribes", [gauge]),
      voterCall(chain, "internal_bribes", [gauge]),
    ]),
  );
  return pools.flatMap((pool, i) =>
    [1, 2].map((k) => ({
      pool,
      bribe: perGauge[3 * i + k] as Address,
      fees: k === 2,
      alive: perGauge[3 * i] === true,
    })),
  );
}

export async function readRewardTokens<B extends { bribe: Address }>(
  read: Reader,
  bribes: B[],
  tokens: Address[],
): Promise<(B & { token: Address })[]> {
  const lengths = await read<bigint>(bribes.map((b) => bribeCall(b.bribe, "rewardsListLength")));
  const slots = bribes.flatMap((b, k) =>
    Array.from({ length: Number(lengths[k]) }, (_, j) => ({ b, index: BigInt(j) })),
  );
  const slotTokens = await read<Address>(slots.map(({ b, index }) => bribeCall(b.bribe, "rewardTokens", [index])));
  const whitelisted = new Map(tokens.map((token) => [lower(token), token]));
  return slots.flatMap(({ b }, k) => {
    const token = whitelisted.get(lower(slotTokens[k]!));
    return token ? [{ ...b, token }] : [];
  });
}

/** Every pool of the Voter with a live gauge and rewards this epoch in `tokens`, with those rewards alone. */
export async function readRewards(chain: Chain, tokens: Address[]): Promise<PoolRewards[]> {
  const read: Reader = <T>(calls: Call[]) => readMany<T>(chain.client, calls);
  const live = (await readBribes(chain, read)).filter((b) => b.alive);
  const kept = await readRewardTokens(read, live, tokens);
  const calendar = calendarEpoch();
  const results = await read<number | [bigint, bigint, bigint]>([
    ...tokens.map(decimalsCall),
    ...kept.map((s) => bribeCall(s.bribe, "rewardData", [s.token, calendar])),
  ]);
  const decimalsOf = new Map(tokens.map((token, i) => [lower(token), results[i] as number]));
  const rewards = new Map<Address, Reward[]>();
  kept.forEach(({ pool, token }, k) => {
    const [, amount] = results[tokens.length + k] as [bigint, bigint, bigint];
    if (amount === 0n) return;
    rewards.set(pool, [...(rewards.get(pool) ?? []), { token, amount, decimals: decimalsOf.get(lower(token))! }]);
  });
  return [...rewards].map(([pool, list]) => ({ pool, rewards: list }));
}

/**
 * The epoch, as `readEpoch`, and the votes on `pools`: the conduit's this epoch, and everyone else's. For up to 498
 * pools, all comes from one eth_call, and so from one block. `pending` reads the block being built.
 */
export async function readVotes(chain: Chain, pools: PoolRewards[], blockTag?: "pending"): Promise<State> {
  const results = await readMany<bigint>(
    chain.client,
    [
      ...epochCalls(chain, calendarEpoch()),
      ...pools.flatMap(({ pool }) => [
        voterCall(chain, "weights", [pool]),
        voterCall(chain, "votes", [chain.conduit, pool]),
      ]),
    ],
    { blockTag },
  );
  const epoch = toEpoch(results.slice(0, 3));
  return {
    epoch,
    pools: pools.map((p, i) => {
      // Voter.votes keeps last epoch's vote until the next vote resets it.
      const ownVotes = epoch.votedThisEpoch ? results[4 + 2 * i]! : 0n;
      return { ...p, otherVotes: results[3 + 2 * i]! - ownVotes, ownVotes };
    }),
  };
}

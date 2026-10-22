import { erc20Abi, type Address } from "viem";
import { bribeAbi, veAbi } from "./abi.ts";
import { call, lower, now, readMany, voterCall, WEEK, type Call, type Chain, type Client } from "./chain.ts";

export type Votes = { power: bigint; lastVoted: bigint; votedThisEpoch: boolean };

export type Epoch = { start: bigint; flip: bigint; v2?: Votes | undefined } & Votes;

type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; rewards: Reward[] };

/** `otherVotes` is everyone's but the Klima conduit's, so it includes the immutable conduit's `v2Votes`. */
export type State = {
  epoch: Epoch;
  pools: (PoolRewards & { otherVotes: bigint; ownVotes: bigint; v2Votes: bigint })[];
};

const calendarEpoch = () => (now() / WEEK) * WEEK;

export const bribeCall = (address: Address, functionName: string, args?: readonly unknown[]) =>
  call(address, bribeAbi, functionName, args);

const decimalsCall = (address: Address) => call(address, erc20Abi, "decimals");

export async function readDecimals(client: Client, tokens: Address[]): Promise<Map<string, number>> {
  const decimals = await readMany<number>(client, tokens.map(decimalsCall));
  return new Map(tokens.map((token, i) => [lower(token), decimals[i]!]));
}

function epochCalls(chain: Chain, calendar: bigint): Call[] {
  const { ve, conduit, v2 } = chain;
  const votesOf = (voter: Address): Call[] => [
    voterCall(chain, "lastVoted", [voter]),
    call(ve, veAbi, "getPastVotes", [voter, calendar]),
  ];
  return [voterCall(chain, "_epochTimestamp"), ...votesOf(conduit), ...(v2 ? votesOf(v2.conduit) : [])];
}

function toEpoch([start, lastVoted, power, v2LastVoted, v2Power]: bigint[]): Epoch {
  const votes = (last: bigint, power: bigint) => ({ power, lastVoted: last, votedThisEpoch: last >= start! });
  return {
    start: start!,
    flip: start! + WEEK,
    ...votes(lastVoted!, power!),
    ...(v2LastVoted === undefined ? {} : { v2: votes(v2LastVoted, v2Power!) }),
  };
}

/**
 * Voting power is read at the start of the calendar week, and `assertFresh` checks that the Voter's epoch starts then
 * too.
 */
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
 * Up to 331 pools, or 498 without the immutable conduit, fit in one eth_call, so every vote is read from the same
 * block.
 */
export async function readVotes(chain: Chain, pools: PoolRewards[], blockTag?: "pending"): Promise<State> {
  const { conduit, v2 } = chain;
  const epochs = epochCalls(chain, calendarEpoch());
  const perPool = (pool: Address) => [
    voterCall(chain, "weights", [pool]),
    voterCall(chain, "votes", [conduit, pool]),
    ...(v2 ? [voterCall(chain, "votes", [v2.conduit, pool])] : []),
  ];
  const stride = v2 ? 3 : 2;
  const results = await readMany<bigint>(chain.client, [...epochs, ...pools.flatMap(({ pool }) => perPool(pool))], {
    blockTag,
  });
  const epoch = toEpoch(results.slice(0, epochs.length));
  return {
    epoch,
    pools: pools.map((p, i) => {
      const [weight, own, v2Own] = results.slice(epochs.length + stride * i, epochs.length + stride * (i + 1));
      // Voter.votes still holds last epoch's vote until the conduit votes again.
      const ownVotes = epoch.votedThisEpoch ? own! : 0n;
      const v2Votes = epoch.v2?.votedThisEpoch ? v2Own! : 0n;
      return { ...p, otherVotes: weight! - ownVotes, ownVotes, v2Votes };
    }),
  };
}

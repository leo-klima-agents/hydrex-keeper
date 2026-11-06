import { erc20Abi, type Address } from "viem";
import { bribeAbi, veAbi } from "./abi.ts";
import {
  call,
  CONDUITS,
  lower,
  now,
  byConduit,
  readEach,
  readMany,
  voterCall,
  WEEK,
  type Call,
  type Chain,
  type Client,
  type ConduitName,
  type ByConduit,
} from "./chain.ts";

export type Votes = { power: bigint; lastVoted: bigint; votedThisEpoch: boolean };

export type Epoch = { start: bigint; flip: bigint; votes: ByConduit<Votes> };

type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; rewards: Reward[] };

/** `weight` is every vote on the pool, and `votes` each conduit's, which only count once it voted this epoch. */
export type PoolVotes = PoolRewards & { weight: bigint; votes: ByConduit<bigint> };

/**
 * `scores` are the scores that a conduit checking votes on chain gives its vote in force, in wei of USD, for those that
 * could score it.
 */
export type State = { epoch: Epoch; pools: PoolVotes[]; scores: Partial<ByConduit<bigint>> };

/** Everyone's votes on the pool but `name`'s. */
export const othersOf = ({ weight, votes }: PoolVotes, name: ConduitName) => weight - votes[name];

const calendarEpoch = () => (now() / WEEK) * WEEK;

export const bribeCall = (address: Address, functionName: string, args?: readonly unknown[]) =>
  call(address, bribeAbi, functionName, args);

const decimalsCall = (address: Address) => call(address, erc20Abi, "decimals");

export async function readDecimals(client: Client, tokens: Address[]): Promise<Map<string, number>> {
  const decimals = await readMany<number>(client, tokens.map(decimalsCall));
  return new Map(tokens.map((token, i) => [lower(token), decimals[i]!]));
}

/** The epoch's start, then each conduit's last vote and voting power, in the order of CONDUITS. */
function epochCalls(chain: Chain, calendar: bigint): Call[] {
  const votesOf = ({ address }: { address: Address }): Call[] => [
    voterCall(chain, "lastVoted", [address]),
    call(chain.ve, veAbi, "getPastVotes", [address, calendar]),
  ];
  return [voterCall(chain, "_epochTimestamp"), ...CONDUITS.flatMap((name) => votesOf(chain.conduits[name]))];
}

function toEpoch([start, ...rest]: bigint[]): Epoch {
  const votes = byConduit((name) => {
    const [lastVoted, power] = rest.slice(2 * CONDUITS.indexOf(name));
    return { power: power!, lastVoted: lastVoted!, votedThisEpoch: lastVoted! >= start! };
  });
  return { start: start!, flip: start! + WEEK, votes };
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
 * Up to 331 pools fit in one eth_call, so every vote, and the score of each conduit that checks votes, is read from the
 * same block. Only the scores may revert.
 */
export async function readVotes(chain: Chain, pools: PoolRewards[]): Promise<State> {
  const epochs = epochCalls(chain, calendarEpoch());
  const stride = 1 + CONDUITS.length;
  const perPool = (pool: Address) => [
    voterCall(chain, "weights", [pool]),
    ...CONDUITS.map((name) => voterCall(chain, "votes", [chain.conduits[name].address, pool])),
  ];
  const checking = CONDUITS.filter((name) => chain.conduits[name].priced);
  const scoreOf = (name: ConduitName) => {
    const { address, abi } = chain.conduits[name];
    return call(address, abi, "currentScore");
  };
  const calls = [...epochs, ...pools.flatMap(({ pool }) => perPool(pool))];
  const results = await readEach<bigint>(chain.client, [...calls, ...checking.map(scoreOf)]);
  const scored = results.splice(calls.length);
  const reverted = results.findIndex((result) => result === undefined);
  if (reverted >= 0) throw new Error(`${calls[reverted]!.functionName} reverted`);
  const epoch = toEpoch(results.slice(0, epochs.length) as bigint[]);
  const scores: Partial<ByConduit<bigint>> = {};
  checking.forEach((name, i) => {
    if (scored[i] !== undefined) scores[name] = scored[i];
  });
  return {
    epoch,
    pools: pools.map((p, i) => {
      const [weight, ...own] = results.slice(epochs.length + stride * i, epochs.length + stride * (i + 1));
      // Voter.votes still holds last epoch's vote until the conduit votes again.
      const votes = byConduit((name) => (epoch.votes[name].votedThisEpoch ? own[CONDUITS.indexOf(name)]! : 0n));
      return { ...p, weight: weight!, votes };
    }),
    scores,
  };
}

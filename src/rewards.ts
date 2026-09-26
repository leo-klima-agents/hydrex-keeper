import type { Address } from "viem";
import { bribeAbi, erc20Abi, veAbi, voterAbi } from "./abi.ts";
import { readMany, WEEK, type Chain } from "./chain.ts";

/** `currentVote` is empty unless the conduit voted in this epoch: votes do not carry over. */
export type Epoch = { start: bigint; flip: bigint; power: bigint; votedThisEpoch: boolean; currentVote: Address[] };

export type Reward = { token: Address; amount: bigint; decimals: number };

export type PoolRewards = { pool: Address; alive: boolean; otherVotes: bigint; rewards: Reward[] };

/** Current epoch, the conduit's power in it and the pools it currently votes for. */
export async function readEpoch(chain: Chain): Promise<Epoch> {
  const { client, voter, ve, conduit } = chain;
  const [start, lastVoted, poolVoteLength] = (await readMany<bigint>(client, [
    { address: voter, abi: voterAbi, functionName: "_epochTimestamp" },
    { address: voter, abi: voterAbi, functionName: "lastVoted", args: [conduit] },
    { address: voter, abi: voterAbi, functionName: "poolVoteLength", args: [conduit] },
  ])) as [bigint, bigint, bigint];
  const votedThisEpoch = lastVoted >= start;
  const [power, ...currentVote] = await readMany<bigint | Address>(client, [
    { address: ve, abi: veAbi, functionName: "getPastVotes", args: [conduit, start] },
    ...Array.from({ length: votedThisEpoch ? Number(poolVoteLength) : 0 }, (_, i) => ({
      address: voter,
      abi: voterAbi,
      functionName: "poolVote",
      args: [conduit, BigInt(i)],
    })),
  ]);
  return { start, flip: start + WEEK, power: power as bigint, votedThisEpoch, currentVote: currentVote as Address[] };
}

/** This epoch's bribes and fees per pool, and the votes each pool has from others. */
export async function readRewards(chain: Chain, pools: Address[], epoch: Epoch): Promise<PoolRewards[]> {
  const { client, voter, conduit } = chain;
  const v = (functionName: string, args: readonly unknown[]) => ({ address: voter, abi: voterAbi, functionName, args });

  const gauges = await readMany<Address>(client, pools.map((pool) => v("gauges", [pool])));
  const perPool = await readMany<boolean | bigint | Address>(
    client,
    gauges.flatMap((gauge, i) => [
      v("isAlive", [gauge]),
      v("weights", [pools[i]]),
      v("votes", [conduit, pools[i]]),
      v("external_bribes", [gauge]),
      v("internal_bribes", [gauge]),
    ]),
  );
  const bribes = pools.map((_, i) => [perPool[5 * i + 3] as Address, perPool[5 * i + 4] as Address]).flat();

  const lengths = await readMany<bigint>(
    client,
    bribes.map((address) => ({ address, abi: bribeAbi, functionName: "rewardsListLength" })),
  );
  const slots = bribes.flatMap((address, b) =>
    Array.from({ length: Number(lengths[b]) }, (_, j) => ({ bribe: b, address, index: BigInt(j) })),
  );
  const tokens = await readMany<Address>(
    client,
    slots.map((s) => ({ address: s.address, abi: bribeAbi, functionName: "rewardTokens", args: [s.index] })),
  );
  const data = await readMany<[bigint, bigint, bigint]>(
    client,
    slots.map((s, k) => ({ address: s.address, abi: bribeAbi, functionName: "rewardData", args: [tokens[k], epoch.start] })),
  );
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  const decimals = await readMany<number>(
    client,
    distinct.map((address) => ({ address, abi: erc20Abi, functionName: "decimals" })),
  );
  const decimalsOf = new Map(distinct.map((t, i) => [t, decimals[i]!]));

  return pools.map((pool, i) => {
    const rewards: Reward[] = [];
    slots.forEach((s, k) => {
      const amount = data[k]![1];
      if (s.bribe >> 1 === i && amount > 0n) {
        const token = tokens[k]!;
        rewards.push({ token, amount, decimals: decimalsOf.get(token.toLowerCase() as Address)! });
      }
    });
    return {
      pool,
      alive: perPool[5 * i] as boolean,
      // Voter.votes keeps last epoch's figure until the next vote resets it.
      otherVotes: (perPool[5 * i + 1] as bigint) - (epoch.votedThisEpoch ? (perPool[5 * i + 2] as bigint) : 0n),
      rewards,
    };
  });
}

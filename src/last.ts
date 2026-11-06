import {
  decodeFunctionData,
  isAddressEqual,
  keccak256,
  serializeTransaction,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { voterAbi } from "./abi.ts";
import { Blocks, sleep, watch } from "./blocks.ts";
import {
  blocksBetween,
  CONDUITS,
  lastBlockBefore,
  lower,
  msOf,
  otherOf,
  byConduit,
  readMany,
  voterCall,
  WEEK,
  type Chain,
  type Client,
  type Conduit,
  type ConduitName,
  type ByConduit,
} from "./chain.ts";
import { onchainOf, pricedPools, readValues, unscored, type Onchain } from "./check.ts";
import { decide, type Decision, type Planned } from "./decide.ts";
import { errorKind, errorMessage, log, warnOnce } from "./log.ts";
import { tokensOf, valueRewards, type Run } from "./pass.ts";
import type { Prices } from "./prices.ts";
import { assertFresh, readRewards, readVotes, type PoolRewards, type State } from "./read.ts";
import type { Vote } from "./select.ts";
import {
  broadcastTx,
  lastVotedAt,
  markMined,
  nonceTaken,
  prepareVote,
  readFees,
  verifyVote,
  type Fees,
  type Prepared,
  type Rival,
} from "./vote.ts";

const WARMUP_MS = 60_000; // starts this long before the flip to learn the block timing
const PRICES_BY_MS = 5_000; // before the flip
const TICK_MS = 50;
const PLAN_AHEAD_MS = 4_000; // before the first deadline
const PLAN_EVERY_MS = 100;
const MAX_PLANS = 3; // in flight per lane
const RECENT = 30; // plans kept per lane, more than come back for one block
const PREPARED_KEPT = 50; // preparations kept for plans to share
const RETRY_DELAY_MS = 5_000;
const SHARED_READ_MS = 50; // lanes share a read of the votes started this recently
const REREAD_MS = 500; // after a failed read of a checking conduit's values
const FIRST_READ_WAIT_MS = 3_000;
const SETTLE_MS = 10_000; // after the flip, so that lagging RPCs have the last blocks
const OUTCOME_TRIES = 3;
const OUTCOME_RETRY_MS = 2_000;
const WATCHED_S = 10n; // anyone's votes in this many seconds before the flip are logged

/** `target` is the time (ms) of the block a last-block vote was sent for, and `sentAt` when it was sent. */
export type Sent = {
  hash: Hex;
  vote: Vote;
  nonce: number;
  conduit: Conduit;
  votes?: Map<Address, bigint> | undefined;
  target?: number;
  sentAt?: number;
  gas?: bigint;
};

/** What one conduit sends in the block at `time` (ms), planned from a read at `readAt` (ms). */
export type Plan = {
  readAt: number;
  time: number;
  vote: Vote | null;
  note: string;
  prepared?: Prepared;
  /** The conduit's votes on each pool once its vote lands, keyed by lowercase pool. */
  votes?: Map<Address, bigint>;
  /**
   * For a conduit that checks votes on chain: the other conduit's vote that `prepared` was checked after, or null for
   * none.
   */
  rival?: Vote | null;
  /** Whether the vote counts the other conduit's planned vote rather than that one's votes in force. */
  answered?: boolean | undefined;
  summary: Record<string, unknown>;
};

/** `checks` is set for the lane of a conduit that checks votes on chain. */
export type Lane<P> = {
  name: string;
  checks?: boolean;
  plan: () => Promise<P>;
  best?: P | undefined;
  recent?: P[];
};

type Race<P> = {
  blocks: Blocks;
  lanes: Lane<P>[];
  send: (time: number) => void;
};

export function keep<P extends { readAt: number }>(lane: Lane<P>, plan: P): void {
  lane.recent = [...(lane.recent ?? []), plan].slice(-RECENT);
  if (!lane.best || plan.readAt > lane.best.readAt) lane.best = plan;
}

/**
 * Deadlines come from block timing alone, so a hung poll or plan delays nothing. Each lane plans on its own schedule,
 * so a lane whose plans fail or hang holds up no other.
 */
export async function race<P extends { readAt: number }>(
  flip: number,
  { blocks, lanes, send }: Race<P>,
): Promise<number> {
  let done = false;
  const planning = async (lane: Lane<P>) => {
    let failure = "";
    let inFlight = 0;
    for (; !done; await sleep(PLAN_EVERY_MS)) {
      if (inFlight === MAX_PLANS) continue;
      inFlight++;
      void lane
        .plan()
        .then(
          (p) => keep(lane, p),
          (error: unknown) => {
            const kind = errorKind(error);
            if (kind !== failure) log.warning("plan failed", { lane: lane.name, error: errorMessage(error) });
            failure = kind;
          },
        )
        .finally(() => inFlight--);
    }
  };
  let planned = false;
  let sends = 0;
  let after = -Infinity;
  for (;;) {
    const now = Date.now();
    const time = blocks.next(flip, after, now);
    if (time === undefined) {
      if (blocks.building(now) !== undefined || now >= flip) break;
      await sleep(TICK_MS);
      continue;
    }
    const deadline = time - blocks.timing.lead;
    if (!planned && now >= deadline - PLAN_AHEAD_MS) {
      planned = true;
      log.info("planning", { block: time / 1000, secondsToDeadline: (deadline - now) / 1000, ...blocks.timing });
      for (const lane of lanes) void planning(lane);
    }
    if (now < deadline) {
      await sleep(Math.min(deadline - now, TICK_MS));
      continue;
    }
    after = time;
    send(time);
    sends++;
  }
  done = true;
  return sends;
}

export type Together = ByConduit<
  Decision & {
    /** The conduit's votes on each pool once its vote lands, keyed by lowercase pool. */
    byPool: Map<Address, bigint>;
    /** Whether its vote counts the other conduit's planned vote rather than that one's votes in force. */
    answered: boolean;
    /** For a conduit that checks votes on chain: the other conduit's vote, if that goes out, to check its own after. */
    rival: Vote | undefined;
  }
>;

/** For each conduit: whether it votes, whether it checks votes on chain, and whether its plans succeed. */
export type Roles = ByConduit<{ voting: boolean; checks: boolean; trusted: boolean }>;

/**
 * Both conduits' votes for the block at `time` (ms), decided from one read, so that the two plans made from it pair up
 * in `pick`. A conduit that checks votes on chain decides against the votes in force, since its vote must clear its
 * check whichever lands first, and is checked after the other conduit's vote too. The other counts its vote if that goes
 * out in the same block: it votes, hasn't voted in that second yet, and its plans succeed (`trusted`). Otherwise it
 * counts its votes in force.
 */
export function decideTogether(
  state: State,
  time: number,
  usd: number[],
  onchain: Partial<ByConduit<Onchain>>,
  roles: Roles,
): Together {
  const goesOut = (name: ConduitName, { vote }: Decision) =>
    roles[name].voting && !!vote && !votedInSecond(state.epoch.votes[name].lastVoted, time);
  const byPool = ({ votes }: Decision) => new Map(state.pools.map((p, i) => [lower(p.pool), votes[i]!]));
  const checking = CONDUITS.filter((name) => roles[name].checks);
  const first = byConduit((name) => (roles[name].checks ? decide(name, state, usd, { onchain: onchain[name] }) : null));
  const planned: Planned = {};
  for (const name of checking) {
    if (roles[name].trusted && goesOut(name, first[name]!)) planned[name] = byPool(first[name]!);
  }
  const decisions = byConduit((name) => first[name] ?? decide(name, state, usd, { planned }));
  return byConduit((name) => {
    const decision = decisions[name];
    const other = otherOf(name);
    const rival = roles[name].checks && !roles[other].checks && goesOut(other, decisions[other]);
    return {
      ...decision,
      byPool: byPool(decision),
      answered: !roles[name].checks && planned[other] !== undefined,
      rival: rival ? decisions[other].vote! : undefined,
    };
  });
}

/**
 * The nonces of an open conduit's sent votes that `state` shows in force. Anyone can vote for that conduit, so its
 * `lastVoted` doesn't say whose vote landed. But a vote in force that matches a sent one on every pool is that one, and
 * its nonce is used, whatever a lagging node says.
 */
export function landed(state: State, name: ConduitName, sent: Iterable<Sent>): number[] {
  if (!state.epoch.votes[name].votedThisEpoch) return [];
  return [...sent].flatMap(({ conduit, votes, nonce }) =>
    conduit.name === name && votes && state.pools.every((p) => p.votes[name] === (votes.get(lower(p.pool)) ?? 0n))
      ? [nonce]
      : [],
  );
}

function forBlock(lane: Lane<Plan> | undefined, time: number): (Plan | undefined)[] {
  if (!lane?.best) return [undefined];
  const plans = (lane.recent ?? []).filter((p) => p.time === time);
  return plans.length ? plans : [lane.best];
}

/**
 * What each conduit sends in the block at `time` (ms). The vote of a conduit that checks votes on chain only goes out
 * with the other conduit's vote it was checked after, so that it clears its check whichever lands first. Among the
 * plans for that block, the pair whose older plan is freshest wins, out of the pairs where at most one conduit votes or
 * the checking conduit's vote was checked after the other's. With no such pair, the checking conduit doesn't vote and
 * `unpaired` is set. Its votes in force then stay, so the other conduit sends its freshest plan that counted those, or
 * else its `freshest`.
 */
export function pick(
  time: number,
  lanes: Partial<ByConduit<Lane<Plan> | undefined>>,
): { plans: Partial<ByConduit<Plan>>; unpaired?: true; freshest?: Partial<ByConduit<Plan>> } {
  const fresh = (p: Plan | undefined) => p?.readAt ?? Infinity;
  // A checking conduit's plan fits the other's if it was checked after the other's vote.
  const fits = (p: Plan | undefined, q: Plan | undefined) =>
    p?.rival === undefined || !p.prepared || !q?.prepared || same(p.rival, q.vote);
  const options = byConduit((name) => forBlock(lanes[name], time));
  let best: { plans: ByConduit<Plan | undefined>; stale: number; freshest: number } | undefined;
  for (const klima of options.klima) {
    for (const immutable of options.immutable) {
      if (!fits(klima, immutable) || !fits(immutable, klima)) continue;
      const [stale, freshest] = [Math.min(fresh(klima), fresh(immutable)), Math.max(fresh(klima), fresh(immutable))];
      if (!best || stale > best.stale || (stale === best.stale && freshest > best.freshest)) {
        best = { plans: { klima, immutable }, stale, freshest };
      }
    }
  }
  const defined = (plans: ByConduit<Plan | undefined>) => {
    const result: Partial<ByConduit<Plan>> = {};
    for (const name of CONDUITS) if (plans[name]) result[name] = plans[name];
    return result;
  };
  if (best) return { plans: defined(best.plans) };
  const freshestOf = (plans: (Plan | undefined)[]) => plans.reduce((a, b) => (fresh(b) > fresh(a) ? b : a));
  const freshest = byConduit((name) => freshestOf(options[name]));
  const plans = byConduit((name) => {
    if (lanes[name]?.checks) return undefined;
    const inForce = options[name].filter((p) => p && !p.answered);
    return inForce.length ? freshestOf(inForce) : freshest[name];
  });
  return { plans: defined(plans), unpaired: true, freshest: defined(freshest) };
}

/**
 * Gives the last value `read` returned. It reads again in the background on the first call with a new `key`, and
 * REREAD_MS after a failed read, one read at a time. Until there is a value, calls wait for one, but only until `wait`
 * ms after the first call, so a read that hangs or keeps failing holds back no later plan.
 */
export function refreshed<T>(
  read: () => Promise<T>,
  unread: (error: unknown) => void,
  wait = FIRST_READ_WAIT_MS,
): (key: number) => Promise<{ value: T; version: number } | undefined> {
  let last: { value: T; version: number } | undefined;
  let reading: { key: number; done: Promise<void>; settled: boolean; failedAt?: number } | undefined;
  let waitUntil: number | undefined;
  return async (key) => {
    const failedAt = reading?.failedAt;
    const due =
      !reading ||
      (reading.settled && (failedAt !== undefined ? Date.now() - failedAt >= REREAD_MS : reading.key !== key));
    if (due) {
      const entry: NonNullable<typeof reading> = { key, done: Promise.resolve(), settled: false };
      entry.done = read().then(
        (value) => {
          last = { value, version: (last?.version ?? 0) + 1 };
          entry.settled = true;
        },
        (error: unknown) => {
          entry.failedAt = Date.now();
          entry.settled = true;
          unread(error);
        },
      );
      reading = entry;
    }
    waitUntil ??= Date.now() + wait;
    const left = waitUntil - Date.now();
    if (!last && left > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([reading!.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, left)))]);
      clearTimeout(timer);
    }
    return last;
  };
}

function memo<T>(): (key: string, decide: () => T) => T {
  let last: { key: string; value: T } | undefined;
  return (key, decide) => (last?.key === key ? last : (last = { key, value: decide() })).value;
}

/**
 * Makes each value once per key: calls with a key whose value is being made, or was made, share it. A value whose
 * making fails is forgotten, so the next call with its key tries again. Only the last `kept` keys are kept.
 */
export function oncePer<T>(kept = PREPARED_KEPT): (key: string, make: () => Promise<T>) => Promise<T> {
  const made = new Map<string, Promise<T>>();
  return (key, make) => {
    let value = made.get(key);
    if (!value) {
      const making = make();
      made.set(key, making);
      making.catch(() => made.get(key) === making && made.delete(key));
      if (made.size > kept) made.delete(made.keys().next().value!);
      value = making;
    }
    return value;
  };
}

const keyOf = ({ epoch, pools, scores }: State) =>
  [
    epoch.start,
    ...CONDUITS.flatMap((name) => [epoch.votes[name].power, epoch.votes[name].lastVoted, scores[name]]),
    ...pools.flatMap((p) => [p.weight, ...CONDUITS.map((name) => p.votes[name])]),
  ].join();

const voteKey = (vote: Vote | undefined) => (vote ? `${vote.pools.join()}:${vote.weights.join()}` : "-");

// The tip, and the power of two the base fee is under: as long as the base fee stays under it, twice the base fee a
// vote was prepared with still covers it with the tip on top, so the vote pays its tip in full.
const feeKey = ({ tip, baseFee }: Fees) => `${tip}:${baseFee.toString(2).length}`;

/** What the lanes plan from: the votes and the fees, read once for the lanes that plan at about the same time. */
export type Snapshot = { readAt: number; time: number; read: Promise<{ state: State; fees: Fees }> };

type Values = { value: Map<Address, number>; version: number };

export type Planning = {
  chain: Chain;
  /** Which conduits vote: those with voting power this epoch. */
  voting: ByConduit<boolean>;
  dryRun: boolean;
  signers: ByConduit<LocalAccount | undefined>;
  /** The rewards of the pools whose votes are read, in USD. */
  usd: () => number[];
  snapshot: () => Snapshot;
  /** For each conduit that checks votes on chain: its values of the pools, by the second of a read. */
  values: Partial<ByConduit<(key: number) => Promise<Values | undefined>>>;
  sent: Map<Hex, Sent>;
  prepareVote?: typeof prepareVote;
};

/**
 * Each conduit's lane. Both decide both votes from the snapshot they share, so neither waits for the other's plans,
 * and the plans made from one snapshot pair up in `pick`. Plans with the same inputs share one preparation, finished or
 * under way, so that a plan reads and decides, but only waits for a simulation and a signature when something changed.
 * A vote that landed since may have taken the nonce of one prepared before, so `lastVoted` is one of the inputs, and so
 * are the fees, so that the tip follows the blocks.
 */
export function lanesOf(planning: Planning): ByConduit<Lane<Plan>> {
  const { chain, voting, dryRun, signers, sent } = planning;
  const { conduits } = chain;
  const prepareWith = planning.prepareVote ?? prepareVote;
  const preparing = oncePer<Prepared>();
  const prepare = async (base: Plan, lastVoted: bigint, fees: Fees, conduit: Conduit, rival?: Rival): Promise<Plan> => {
    const { time } = base;
    if (!base.vote) return base;
    if (votedInSecond(lastVoted, time)) return { ...base, note: "already voted in this second" };
    const second = BigInt(Math.floor(time / 1000));
    const key = [conduit.from, second, lastVoted, voteKey(base.vote), voteKey(rival?.vote), feeKey(fees)].join("|");
    const target = { time: second, lastVoted };
    const { vote } = base;
    const options = { target, rival, fees };
    const signer = signers[conduit.name];
    const prepared = await preparing(key, () => prepareWith(chain, conduit, signer, vote, dryRun, options));
    return { ...base, prepared, ...(conduit.priced ? { rival: rival?.vote ?? null } : {}) };
  };

  const warnUnscored = byConduit((name) => unscored(conduits[name]));
  // Whether a conduit's last plan failed or can't be sent, so that the other conduit counts its votes in force rather
  // than a vote that won't go out.
  const failing = byConduit(() => false);
  const plain = byConduit(() => memo<Decision>());
  const decided = memo<Together>();
  const decisionsOf = async ({ readAt, time }: Snapshot, state: State): Promise<Together> => {
    const usd = planning.usd();
    const key = keyOf(state);
    const onchain: Partial<ByConduit<Onchain>> = {};
    const versions: (number | undefined)[] = [];
    for (const name of CONDUITS) {
      const values = planning.values[name];
      if (!voting[name] || !values || !plain[name](key, () => decide(name, state, usd)).vote) continue;
      const read = await values(Math.floor(readAt / 1000));
      if (state.scores[name] === undefined) warnUnscored[name](new Error("currentScore reverted"));
      const checks = onchainOf(state, name, read?.value);
      if (checks) onchain[name] = checks;
      versions.push(checks && read!.version);
    }
    const roles = byConduit((name) => ({
      voting: voting[name],
      checks: conduits[name].priced !== undefined,
      trusted: !failing[name],
    }));
    const trusted = CONDUITS.map((name) => roles[name].trusted);
    return decided(`${key}|${versions.join()}|${time}|${trusted.join()}`, () =>
      decideTogether(state, time, usd, onchain, roles),
    );
  };

  const laneOf = (name: ConduitName): Lane<Plan> => {
    const conduit = conduits[name];
    return {
      name,
      checks: conduit.priced !== undefined,
      plan: async () => {
        try {
          const snapshot = planning.snapshot();
          const { state, fees } = await snapshot.read;
          assertFresh(state.epoch);
          if (conduit.open)
            for (const nonce of landed(state, name, sent.values())) markMined(chain, nonce, conduit.from);
          const { vote, note, summary, byPool, answered, rival } = (await decisionsOf(snapshot, state))[name];
          const base = { readAt: snapshot.readAt, time: snapshot.time, vote, note, summary, votes: byPool, answered };
          const against = rival && { conduit: conduits[otherOf(name)], vote: rival };
          const plan = await prepare(base, state.epoch.votes[name].lastVoted, fees, conduit, against);
          failing[name] = plan.prepared !== undefined && plan.prepared.signed === undefined && !dryRun;
          return plan;
        } catch (error) {
          failing[name] = true;
          throw error;
        }
      },
    };
  };

  return byConduit(laneOf);
}

export async function lastBlocks(run: Run, flip: bigint, voting: ByConduit<boolean>): Promise<number> {
  const { chain, signers, dryRun } = run;
  const { conduits } = chain;
  const flipMs = Number(flip) * 1000;
  // Prices fetched now are reused if every source fails during the warm-up.
  if (Date.now() < flipMs - WARMUP_MS) {
    await run
      .prices(tokensOf(run), flipMs - WARMUP_MS)
      .catch((error: unknown) => log.warning("prices not fetched ahead", { error: errorMessage(error) }));
  }
  await sleep(Math.max(0, flipMs - WARMUP_MS - Date.now()));
  log.info("last blocks", { flip, secondsToFlip: (flipMs - Date.now()) / 1000, voting });
  const blocks = new Blocks();
  let watching = true;
  void watch(chain.client, blocks, () => !watching);
  let failures = 0;
  let rewards: PoolRewards[] = [];
  let priced: Prices = new Map();
  let usd: number[] = [];

  // Two signatures of the same transaction differ, so copies are matched by the unsigned hash.
  const sent = new Map<Hex, Sent>();

  // The latest block's votes, and the fees, read once for the lanes that plan at about the same time. A plan is for the
  // block of the next vote as of when its read started.
  let votes: Snapshot | undefined;
  const votesNow = () => {
    const now = Date.now();
    if (!votes || now - votes.readAt >= SHARED_READ_MS) {
      const read = Promise.all([readVotes(chain, rewards), readFees(chain.client)]);
      const time = blocks.upcoming(flipMs, now) ?? now;
      votes = { readAt: now, time, read: read.then(([state, fees]) => ({ state, fees })) };
    }
    return votes;
  };

  // A checking conduit's pool values barely move and are slow to read, so plans use the last ones, refreshed in the
  // background once per second. Until the first values come, plans go without them, and the simulation checks their
  // votes. Its score of the vote in force changes with every vote, so it is read with the votes.
  const values: Partial<ByConduit<(key: number) => Promise<Values | undefined>>> = {};
  for (const name of CONDUITS) {
    const conduit = conduits[name];
    const { priced: tokens } = conduit;
    if (!tokens) continue;
    const valuesUnread = warnOnce(`${conduit.label}'s values unread; its simulation checks the vote`, {
      conduit: conduit.address,
    });
    values[name] = refreshed(() => readValues(conduit, chain.bulk, pricedPools(rewards, tokens)), valuesUnread);
  }
  const lanesByName = lanesOf({ chain, voting, dryRun, signers, usd: () => usd, snapshot: votesNow, values, sent });
  const lanes = CONDUITS.filter((name) => voting[name]).map((name) => lanesByName[name]);
  if (lanes.length === 0) {
    watching = false;
    return 0;
  }

  for (;;) {
    try {
      const head = await chain.client.getBlock();
      const time = msOf(head);
      if (time !== undefined) blocks.observe({ number: head.number, time }, Date.now());
      rewards = await readRewards(chain, tokensOf(run));
      priced = await run.prices(tokensOf(run), flipMs - PRICES_BY_MS);
      // Prices that value no reward fail here, and are fetched again.
      usd = valueRewards(run, rewards, priced, false);
      break;
    } catch (error) {
      const retry = Date.now() + RETRY_DELAY_MS < flipMs - PRICES_BY_MS;
      log.error(`last blocks: warm-up failed${retry ? ", retrying" : ""}`, { error: errorMessage(error) });
      if (!retry) {
        watching = false;
        return 1;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  // Logs each pool with its votes as the first plans see them. If that read fails, those plans fail and log it.
  void votesNow()
    .read.then(({ state }) => valueRewards(run, state.pools, priced, true))
    .catch(() => undefined);
  // Each lane's first plan is retried until one comes back, while the race starts. It is sent if no later plan is.
  void Promise.all(
    lanes.map(async (lane) => {
      while (!lane.best && Date.now() + RETRY_DELAY_MS < flipMs - PRICES_BY_MS) {
        try {
          keep(lane, await lane.plan());
        } catch (error) {
          log.error("last blocks: first plan failed, retrying", { lane: lane.name, error: errorMessage(error) });
          await sleep(RETRY_DELAY_MS);
        }
      }
    }),
  );

  const sending: Promise<void>[] = [];
  const sendOne = (plan: Plan | undefined, conduit: Conduit, time: number, at: Record<string, unknown>) => {
    const { address } = conduit;
    if (!plan) {
      failures++;
      return log.error("nothing planned in time", { conduit: address, ...at });
    }
    const fields = { conduit: address, ...at, ageMs: Date.now() - plan.readAt, ...plan.summary };
    const { prepared } = plan;
    if (!prepared) return log.info(plan.note, fields);
    const { tx, signed } = prepared;
    if (!signed) return log.info("not signed, not sent", fields);
    if (dryRun) return log.info("dry run: signed, not sent", fields);
    const id = keccak256(serializeTransaction(tx));
    if (sent.has(id)) return log.info("already sent", { conduit: address, ...at });
    const { nonce, gas } = tx;
    const record = { hash: keccak256(signed), vote: plan.vote!, nonce, conduit, votes: plan.votes, gas };
    sent.set(id, { ...record, target: time, sentAt: Date.now() });
    log.info("voting", { ...fields, nonce: tx.nonce, tip: tx.maxPriorityFeePerGas });
    sending.push(
      broadcastTx(chain, { ...prepared, signed }, flipMs).then(
        (hash) => log.info("vote sent", { conduit: address, hash }),
        async (error: unknown) => {
          const notSent = { conduit: address, nonce: tx.nonce, error: errorMessage(error) };
          if (await nonceTaken(chain, tx.nonce, conduit.from)) {
            return log.warning("vote not sent: an earlier vote took its nonce", notSent);
          }
          failures++;
          log.error("vote not sent", notSent);
        },
      ),
    );
  };
  // A checking conduit's vote is sent first, so that at equal tips it reaches the builder first.
  const order = [...CONDUITS].sort((a, b) => Number(!!conduits[b].priced) - Number(!!conduits[a].priced));
  const send = (time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    const voters = byConduit((name) => (voting[name] ? lanesByName[name] : undefined));
    const { plans, unpaired, freshest } = pick(time, voters);
    const ageMs = (plan: Plan | undefined) => plan && Date.now() - plan.readAt;
    for (const name of order) {
      if (!voting[name]) continue;
      const conduit = conduits[name];
      if (unpaired && lanesByName[name].checks) {
        const other = otherOf(name);
        const message = `not voting for ${conduit.label} in this block: no vote of it was checked after ${conduits[other].label}'s`;
        // The other conduit's freshest plan counted a vote that isn't sent, so it sends an older one.
        const older = plans[other] !== freshest?.[other];
        const ages = older ? { otherAgeMs: ageMs(plans[other]), freshestOtherAgeMs: ageMs(freshest?.[other]) } : {};
        log.warning(message, { conduit: conduit.address, ...at, ...ages });
      } else sendOne(plans[name], conduit, time, at);
    }
  };

  const sends = await race(flipMs, { blocks, lanes, send });
  watching = false;
  if (sends === 0) {
    failures++;
    log.error("no block left to vote in before the flip");
  }
  await Promise.all(sending);
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  const voters = CONDUITS.filter((name) => voting[name]).map((name) => conduits[name].address);
  const outcomes = await outcome(run, flip, [...sent.values()], voters);
  await lastVotes(run, flip).catch((error: unknown) =>
    log.warning("votes before the flip unread", { error: errorMessage(error) }),
  );
  return failures + outcomes;
}

type Landed = { gasUsed?: bigint; gasLimit?: bigint; baseFeePerGas?: bigint | null };
type Receipted = { transactionIndex?: number; gasUsed?: bigint; effectiveGasPrice?: bigint };

/** Where a transaction landed: its block's time from the flip (ms), its place in the block, and the tip it paid. */
function landing(flipMs: number, block: Landed, receipt: Receipted) {
  const { baseFeePerGas: baseFee, gasUsed: blockGasUsed, gasLimit: blockGasLimit } = block;
  const { transactionIndex: index, gasUsed, effectiveGasPrice: price } = receipt;
  const ms = msOf(block);
  return {
    msToFlip: ms === undefined ? undefined : ms - flipMs,
    index,
    gasUsed,
    tip: price !== undefined && baseFee != null ? price - baseFee : undefined,
    blockGasUsed,
    blockGasLimit,
  };
}

/**
 * Logs each vote anyone cast in the last WATCHED_S seconds before the flip, ours included, to see how close to the
 * flip other voters vote, and where their votes land in a block. `call` names the function a transaction to the Voter
 * called, so that a poke, which casts a voter's last vote again, shows as one, and `others` counts the votes of others
 * but their pokes. A transaction through another contract shows the selector it called on its `to`, and one that can't
 * be read shows no `call`.
 */
export async function lastVotes({ chain }: Run, flip: bigint): Promise<void> {
  const { client, voter } = chain;
  const [first, last] = await blocksBetween(client, flip - WATCHED_S, flip);
  const events = await client.getContractEvents({
    address: voter,
    abi: voterAbi,
    eventName: "Voted",
    fromBlock: first,
    toBlock: last,
  });
  const votes = new Map<Hex, { voter: Address | undefined; pools: number }>();
  for (const { transactionHash, args } of events) {
    votes.set(transactionHash, { voter: args.voter, pools: (votes.get(transactionHash)?.pools ?? 0) + 1 });
  }
  const ours = new Set(CONDUITS.map((name) => lower(chain.conduits[name].address)));
  const blocks = new Map<bigint, ReturnType<Client["getBlock"]>>();
  const blockOf = (blockNumber: bigint) => {
    if (!blocks.has(blockNumber)) blocks.set(blockNumber, client.getBlock({ blockNumber }));
    return blocks.get(blockNumber)!;
  };
  const callOf = ({ to, input }: { to: Address | null; input: Hex }) => {
    if (to && isAddressEqual(to, voter)) {
      try {
        return decodeFunctionData({ abi: voterAbi, data: input }).functionName;
      } catch {
        // A function of the Voter's that voterAbi leaves out.
      }
    }
    return input.slice(0, 10);
  };
  const rows = await Promise.all(
    [...votes].map(async ([hash, { voter: by, pools }]) => {
      const [receipt, call] = await Promise.all([
        client.getTransactionReceipt({ hash }),
        client.getTransaction({ hash }).then(callOf, () => undefined),
      ]);
      const where = landing(Number(flip) * 1000, await blockOf(receipt.blockNumber), receipt);
      const { from, to, blockNumber: block } = receipt;
      const row = { hash, voter: by, ours: by !== undefined && ours.has(lower(by)), from, to, call };
      return { ...row, pools, block, ...where };
    }),
  );
  rows.sort((a, b) => (a.block === b.block ? (a.index ?? 0) - (b.index ?? 0) : a.block < b.block ? -1 : 1));
  for (const row of rows) log.info("vote before the flip", row);
  log.info("votes before the flip", {
    seconds: WATCHED_S,
    votes: rows.length,
    others: rows.filter((r) => !r.ours && r.call !== "poke").length,
    pokes: rows.filter((r) => r.call === "poke").length,
  });
}

export async function outcome(
  { chain, dryRun }: Run,
  flip: bigint,
  sent: Sent[],
  conduits: Address[],
): Promise<number> {
  let failures = 0;
  const last = new Map<Address, { hash: Hex; vote: Vote; block: bigint; timestamp: bigint }>();
  const flipMs = Number(flip) * 1000;
  for (const { hash, vote, nonce, conduit: sender, target, sentAt, gas } of sent) {
    const conduit = lower(sender.address);
    try {
      const receipt = await chain.client.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      });
      if (!receipt) {
        log.info("vote not mined: replaced or dropped", { conduit, hash });
        continue;
      }
      markMined(chain, nonce, sender.from); // so that the claims after the flip don't reuse its nonce
      const block = receipt.blockNumber;
      const fields = { conduit, hash, block, status: receipt.status };
      const landedIn = await chain.client.getBlock({ blockNumber: block });
      const { timestamp } = landedIn;
      // To tune the timing: how far from its target block a vote lands, how long after it was sent, and how crowded.
      const where = landing(flipMs, landedIn, receipt);
      const ms = msOf(landedIn);
      log.info("vote landed", {
        ...fields,
        ...where,
        ...(ms !== undefined && target !== undefined ? { msAfterTarget: ms - target } : {}),
        ...(ms !== undefined && sentAt !== undefined ? { msAfterSend: ms - sentAt } : {}),
        gasLimit: gas,
      });
      if (timestamp >= flip) log.warning("vote landed after the flip", fields);
      else if (receipt.status !== "success") {
        // The Voter takes one vote per second for a conduit, and anyone can vote for an open one.
        if (sender.open && (await lastVotedAt(chain, conduit, block)) === timestamp) {
          log.warning("vote reverted: another vote for the conduit was first in its second", fields);
        } else {
          failures++;
          log.error("vote reverted", fields);
        }
      } else if (block > (last.get(conduit)?.block ?? -1n)) last.set(conduit, { hash, vote, block, timestamp });
    } catch (error) {
      failures++;
      log.error("vote outcome unknown", { conduit, hash, error: errorMessage(error) });
    }
  }
  for (const [conduit, { vote, hash, block }] of last) {
    await verifyVote(chain, vote, hash, block, conduit).catch((error: unknown) => {
      failures++;
      log.error("vote not confirmed", { conduit, error: errorMessage(error) });
    });
  }
  // Read at the last block before the flip, because anyone can already vote for an open conduit in the next epoch.
  const lastVotedBefore = async () => {
    const before = await lastBlockBefore(chain.client, flip);
    const calls = conduits.map((conduit) => voterCall(chain, "lastVoted", [conduit]));
    return readMany<bigint>(chain.client, calls, { blockNumber: before });
  };
  let lastVoted: bigint[] | undefined;
  for (let attempt = 1; !lastVoted; attempt++) {
    try {
      lastVoted = await lastVotedBefore();
    } catch (error) {
      const fields = { attempt, error: errorMessage(error) };
      if (attempt === OUTCOME_TRIES) {
        (dryRun ? log.warning : log.error)("lastVoted unread", fields);
        return failures + (dryRun ? 0 : 1);
      }
      log.warning("lastVoted unread, retrying", fields);
      await sleep(OUTCOME_RETRY_MS);
    }
  }
  conduits.forEach((conduit, i) => {
    const fields = { conduit, lastVoted: lastVoted[i]! };
    if (fields.lastVoted < flip - WEEK) {
      if (dryRun) return log.warning("no vote this epoch", fields);
      failures++;
      return log.error("no vote this epoch", fields);
    }
    log.info("voted this epoch", fields);
    const ours = last.get(lower(conduit));
    if (ours && fields.lastVoted > ours.timestamp) log.warning("another vote replaced the last one sent", fields);
  });
  return failures;
}

/**
 * Whether a conduit whose last vote was at `lastVoted` (s) already voted in the second of the block at `time` (ms). The
 * Voter takes one vote per conduit per second, and five blocks share a second.
 */
export const votedInSecond = (lastVoted: bigint, time: number) => lastVoted >= BigInt(Math.floor(time / 1000));

const same = (a: Vote | null | undefined, b: Vote | null | undefined) =>
  a === b || (!!a && !!b && a.pools.join() === b.pools.join() && a.weights.join() === b.weights.join());

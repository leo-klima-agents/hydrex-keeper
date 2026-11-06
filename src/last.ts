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
  lastBlockBefore,
  lower,
  msOf,
  readMany,
  voterCall,
  WEEK,
  type Chain,
  type Client,
} from "./chain.ts";
import {
  decideImmutable,
  onchainOf,
  pricedPools,
  readValues,
  type ImmutableDecision,
  type Onchain,
} from "./immutable.ts";
import { errorKind, errorMessage, log, warnOnce } from "./log.ts";
import { tokensOf, UNSCORED, valueRewards, type Run } from "./pass.ts";
import type { Prices } from "./prices.ts";
import { assertFresh, readRewards, readVotes, type PoolRewards, type State } from "./read.ts";
import { select, summarize, type Vote } from "./select.ts";
import {
  broadcastTx,
  klimaSender,
  lastVotedAt,
  immutableSender,
  markMined,
  nonceTaken,
  prepareVote,
  verifyVote,
  type Prepared,
  type Rival,
  type Sender,
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
const REREAD_MS = 500; // after a failed read of the immutable conduit's values
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
  sender: Sender;
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
  /** The immutable conduit's votes on each pool once its vote lands, keyed by lowercase pool. */
  votes?: Map<Address, bigint>;
  /** The other conduit's vote that `prepared` was checked after, if any. */
  rival?: Vote | undefined;
  /** Klima conduit only: whether its vote answered an immutable conduit vote rather than the votes in force. */
  answered?: boolean | undefined;
  summary: Record<string, unknown>;
};

export type Lane<P> = {
  name: string;
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
 * Deadlines come from block timing alone, so a hung poll or plan delays nothing. Lanes plan separately, so a lane that
 * fails or lags holds up no other.
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

/** With `immutableVotes`, those replace the immutable conduit's votes in force. */
function decide({ epoch, pools }: State, usd: number[], immutableVotes?: Map<Address, bigint>) {
  const candidates = pools.map((p, i) => ({
    ...p,
    rewardsUsd: usd[i]!,
    otherVotes:
      p.otherVotes - p.immutableVotes + (immutableVotes ? (immutableVotes.get(lower(p.pool)) ?? 0n) : p.immutableVotes),
  }));
  const { fractions, vote } = select(candidates, epoch.power);
  const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
  return { vote, reason, summary: summarize(candidates, fractions, epoch.power) };
}

export type Decisions = {
  immutable: ImmutableDecision & { byPool: Map<Address, bigint> };
  klima: ReturnType<typeof decide>;
  /** Whether the Klima conduit's vote answers the immutable conduit's rather than its votes in force. */
  answered: boolean;
  /** The Klima conduit's vote, if it goes out in the block: the immutable conduit's vote is checked after it. */
  rival: Vote | undefined;
};

/**
 * Both conduits' votes for the block at `time` (ms), decided from one read, so that the two plans made from it pair up
 * in `pick`. The Klima conduit answers the immutable conduit's vote if that one goes out in the same block: the
 * immutable conduit votes, hasn't voted in that second yet, and its plans succeed (`trusted`). Otherwise it answers the
 * immutable conduit's votes in force.
 */
export function decideBoth(
  state: State,
  time: number,
  usd: number[],
  onchain: Onchain | undefined,
  conduits: { klima: boolean; immutable: boolean; trusted: boolean },
): Decisions {
  const decision = decideImmutable(state, usd, onchain);
  const byPool = new Map(state.pools.map((p, i) => [lower(p.pool), decision.votes[i]!]));
  const { epoch } = state;
  const answered =
    conduits.immutable && conduits.trusted && !!decision.vote && !votedInSecond(epoch.immutable.lastVoted, time);
  const klima = decide(state, usd, answered ? byPool : undefined);
  const sends = conduits.klima && !!klima.vote && !votedInSecond(epoch.lastVoted, time);
  return { immutable: { ...decision, byPool }, klima, answered, rival: sends ? klima.vote! : undefined };
}

/**
 * The nonces of the immutable conduit's sent votes that `state` shows in force. Anyone can vote for that conduit, so
 * its `lastVoted` doesn't say whose vote landed. But a vote in force that matches a sent one on every pool is that one,
 * and its nonce is used, whatever a lagging node says.
 */
export function landed(state: State, sent: Iterable<Sent>): number[] {
  if (!state.epoch.immutable.votedThisEpoch) return [];
  return [...sent].flatMap(({ votes, nonce }) =>
    votes && state.pools.every((p) => p.immutableVotes === (votes.get(lower(p.pool)) ?? 0n)) ? [nonce] : [],
  );
}

function forBlock(lane: Lane<Plan> | undefined, time: number): (Plan | undefined)[] {
  if (!lane?.best) return [undefined];
  const plans = (lane.recent ?? []).filter((p) => p.time === time);
  return plans.length ? plans : [lane.best];
}

/**
 * What each conduit sends in the block at `time` (ms). The immutable conduit's vote only goes out with a Klima vote it
 * was checked after, so that it clears its check whichever lands first. Among the plans for that block, the pair whose
 * older plan is freshest wins, out of the pairs where at most one conduit votes or the immutable conduit's vote was
 * checked after the Klima conduit's. With no such pair, only the Klima conduit votes and `unchecked` is set. The
 * immutable conduit's votes in force then stay, so the Klima conduit sends its freshest plan that answered those, or
 * else its `freshest`.
 */
export function pick(
  time: number,
  klima: Lane<Plan> | undefined,
  immutable: Lane<Plan> | undefined,
): { klima?: Plan | undefined; immutable?: Plan | undefined; unchecked?: true; freshest?: Plan | undefined } {
  const fresh = (p: Plan | undefined) => p?.readAt ?? Infinity;
  const checked = (k: Plan | undefined, v: Plan | undefined) => !k?.prepared || !v?.prepared || same(v.rival, k.vote);
  let best: { klima: Plan | undefined; immutable: Plan | undefined; stale: number; freshest: number } | undefined;
  const klimas = forBlock(klima, time);
  for (const k of klimas) {
    for (const v of forBlock(immutable, time)) {
      if (!checked(k, v)) continue;
      const [stale, freshest] = [Math.min(fresh(k), fresh(v)), Math.max(fresh(k), fresh(v))];
      if (!best || stale > best.stale || (stale === best.stale && freshest > best.freshest)) {
        best = { klima: k, immutable: v, stale, freshest };
      }
    }
  }
  if (best) return { klima: best.klima, immutable: best.immutable };
  const freshestOf = (plans: (Plan | undefined)[]) => plans.reduce((a, b) => (fresh(b) > fresh(a) ? b : a));
  const inForce = klimas.filter((k) => k && !k.answered);
  const freshest = freshestOf(klimas);
  return { klima: inForce.length ? freshestOf(inForce) : freshest, unchecked: true, freshest };
}

/**
 * Gives the last value `read` returned. It reads again in the background on the first call with a new `key`, and
 * REREAD_MS after a failed read, one read at a time. Only calls made before there is any value wait for one, and for at
 * most `wait` ms, so a hung read holds back no plan.
 */
export function refreshed<T>(
  read: () => Promise<T>,
  unread: (error: unknown) => void,
  wait = FIRST_READ_WAIT_MS,
): (key: number) => Promise<{ value: T; version: number } | undefined> {
  let last: { value: T; version: number } | undefined;
  let reading: { key: number; done: Promise<void>; settled: boolean; failedAt?: number } | undefined;
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
    if (!last) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([reading!.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
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

const keyOf = ({ epoch, pools, score }: State) =>
  [
    epoch.start,
    epoch.power,
    epoch.lastVoted,
    epoch.immutable.power,
    epoch.immutable.lastVoted,
    score,
    ...pools.flatMap((p) => [p.otherVotes, p.ownVotes, p.immutableVotes]),
  ].join();

const voteKey = (vote: Vote | undefined) => (vote ? `${vote.pools.join()}:${vote.weights.join()}` : "-");

export async function lastBlocks(
  run: Run,
  flip: bigint,
  conduits: { klima: boolean; immutable: boolean },
): Promise<number> {
  const { chain, account, proposer, dryRun } = run;
  const flipMs = Number(flip) * 1000;
  // Prices fetched now are reused if every source fails during the warm-up.
  if (Date.now() < flipMs - WARMUP_MS) {
    await run
      .prices(tokensOf(run), flipMs - WARMUP_MS)
      .catch((error: unknown) => log.warning("prices not fetched ahead", { error: errorMessage(error) }));
  }
  await sleep(Math.max(0, flipMs - WARMUP_MS - Date.now()));
  log.info("last blocks", { flip, secondsToFlip: (flipMs - Date.now()) / 1000, ...conduits });
  const blocks = new Blocks();
  let watching = true;
  void watch(chain.client, blocks, () => !watching);
  let failures = 0;
  let rewards: PoolRewards[] = [];
  let priced: Prices = new Map();
  let usd: number[] = [];
  let valued: Address[] = [];

  // Plans with the same inputs share one preparation, finished or under way, so that a plan reads the votes and decides
  // but only waits for a simulation and a signature when something changed. A vote that landed since may have taken the
  // nonce of one prepared before, so `lastVoted` is one of the inputs.
  const preparing = oncePer<Prepared>();
  const prepare = async (
    base: Plan,
    lastVoted: bigint,
    sender: Sender,
    signer: LocalAccount | undefined,
    rival?: Rival,
  ): Promise<Plan> => {
    const { time, vote } = base;
    if (!vote) return base;
    if (votedInSecond(lastVoted, time)) return { ...base, note: "already voted in this second" };
    const second = BigInt(Math.floor(time / 1000));
    const key = [sender.from, second, lastVoted, voteKey(vote), voteKey(rival?.vote)].join("|");
    const target = { time: second, lastVoted };
    const prepared = await preparing(key, () => prepareVote(chain, signer, vote, dryRun, target, sender, rival));
    return { ...base, prepared, rival: rival?.vote };
  };

  // Two signatures of the same transaction differ, so copies are matched by the unsigned hash.
  const sent = new Map<Hex, Sent>();

  // The latest block's votes, read once for the lanes that plan at about the same time. A plan is for the block of the
  // next vote as of when its read started.
  type Snapshot = { readAt: number; time: number; state: Promise<State> };
  let votes: Snapshot | undefined;
  const votesNow = () => {
    const now = Date.now();
    if (!votes || now - votes.readAt >= SHARED_READ_MS) {
      votes = { readAt: now, time: blocks.upcoming(flipMs, now) ?? now, state: readVotes(chain, rewards) };
    }
    return votes;
  };

  // The immutable conduit's pool values barely move and are slow to read, so plans use the last ones, refreshed in the
  // background once per second. Until the first values come, plans go without them, and the simulation checks their
  // votes. Its score of the vote in force changes with every vote, so it is read with the votes.
  const valuesNow = refreshed(
    () => readValues(chain, chain.bulk, valued),
    warnOnce("the immutable conduit's values unread; its simulation checks the vote"),
  );
  let scored = true;
  // Whether the immutable conduit's last plan failed or can't be sent, so that the Klima conduit answers its votes in
  // force rather than a vote that won't go out.
  let immutableFailing = false;
  const [plainImmutable, decided] = [memo<ImmutableDecision>(), memo<Decisions>()];
  // Both lanes decide both votes from the read they share, so neither waits for the other's plans.
  const decisionsOf = async ({ readAt, time }: Snapshot, state: State): Promise<Decisions> => {
    const key = keyOf(state);
    let onchain: Onchain | undefined;
    let version = 0;
    if (conduits.immutable && plainImmutable(key, () => decideImmutable(state, usd, undefined)).vote) {
      const values = await valuesNow(Math.floor(readAt / 1000));
      if (state.score === undefined && scored) log.warning(UNSCORED, { conduit: chain.immutable.conduit });
      scored = state.score !== undefined;
      onchain = onchainOf(state, values?.value);
      if (onchain) version = values!.version;
    }
    const trusted = !immutableFailing;
    return decided(`${key}|${version}|${time}|${trusted}`, () =>
      decideBoth(state, time, usd, onchain, { ...conduits, trusted }),
    );
  };

  const immutableLane: Lane<Plan> = {
    name: "immutable",
    plan: async () => {
      try {
        const snapshot = votesNow();
        const state = await snapshot.state;
        assertFresh(state.epoch);
        for (const nonce of landed(state, sent.values())) markMined(chain, nonce, immutableSender(chain).from);
        const { immutable, rival } = await decisionsOf(snapshot, state);
        const { vote, note, summary, byPool } = immutable;
        const base = { readAt: snapshot.readAt, time: snapshot.time, vote, note, summary, votes: byPool };
        const against = rival && { sender: klimaSender(chain), vote: rival };
        const plan = await prepare(base, state.epoch.immutable.lastVoted, immutableSender(chain), proposer, against);
        immutableFailing = plan.prepared !== undefined && plan.prepared.signed === undefined && !dryRun;
        return plan;
      } catch (error) {
        immutableFailing = true;
        throw error;
      }
    },
  };

  const klimaLane: Lane<Plan> = {
    name: "klima",
    plan: async () => {
      const snapshot = votesNow();
      const state = await snapshot.state;
      assertFresh(state.epoch);
      const { klima, answered } = await decisionsOf(snapshot, state);
      const { vote, reason, summary } = klima;
      const base = { readAt: snapshot.readAt, time: snapshot.time, vote, note: reason, summary, answered };
      return prepare(base, state.epoch.lastVoted, klimaSender(chain), account);
    },
  };

  const lanes = [...(conduits.immutable ? [immutableLane] : []), ...(conduits.klima ? [klimaLane] : [])];
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
      valued = pricedPools(rewards, chain.immutable.priced);
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
  const { state: first } = votesNow();
  void first.then(({ pools }) => valueRewards(run, pools, priced, true)).catch(() => undefined);
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
  const sendOne = (plan: Plan | undefined, sender: Sender, time: number, at: Record<string, unknown>) => {
    const { conduit } = sender;
    if (!plan) {
      failures++;
      return log.error("nothing planned in time", { conduit, ...at });
    }
    const fields = { conduit, ...at, ageMs: Date.now() - plan.readAt, ...plan.summary };
    const { prepared } = plan;
    if (!prepared) return log.info(plan.note, fields);
    const { tx, signed } = prepared;
    if (!signed) return log.info("not signed, not sent", fields);
    if (dryRun) return log.info("dry run: signed, not sent", fields);
    const id = keccak256(serializeTransaction(tx));
    if (sent.has(id)) return log.info("already sent", { conduit, ...at });
    const { nonce, gas } = tx;
    const record = { hash: keccak256(signed), vote: plan.vote!, nonce, sender, votes: plan.votes, gas };
    sent.set(id, { ...record, target: time, sentAt: Date.now() });
    log.info("voting", { ...fields, nonce: tx.nonce, tip: tx.maxPriorityFeePerGas });
    sending.push(
      broadcastTx(chain, { ...prepared, signed }, flipMs).then(
        (hash) => log.info("vote sent", { conduit, hash }),
        async (error: unknown) => {
          const notSent = { conduit, nonce: tx.nonce, error: errorMessage(error) };
          if (await nonceTaken(chain, tx.nonce, sender.from)) {
            return log.warning("vote not sent: an earlier vote took its nonce", notSent);
          }
          failures++;
          log.error("vote not sent", notSent);
        },
      ),
    );
  };
  // The immutable conduit's vote is sent first, so that at equal tips it reaches the builder first.
  const send = (time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    const picked = pick(time, conduits.klima ? klimaLane : undefined, conduits.immutable ? immutableLane : undefined);
    if (picked.unchecked) {
      const { klima: alone, freshest } = picked;
      const ageMs = (plan: Plan | undefined) => plan && Date.now() - plan.readAt;
      log.warning(
        "not voting for the immutable conduit in this block: no vote of it was checked after the Klima conduit's",
        {
          conduit: chain.immutable.conduit,
          ...at,
          // Its freshest plan answered a vote that isn't sent, so the Klima conduit sends an older one.
          ...(alone !== freshest ? { klimaAgeMs: ageMs(alone), freshestKlimaAgeMs: ageMs(freshest) } : {}),
        },
      );
    } else if (conduits.immutable) sendOne(picked.immutable, immutableSender(chain), time, at);
    if (conduits.klima) sendOne(picked.klima, klimaSender(chain), time, at);
  };

  const sends = await race(flipMs, { blocks, lanes, send });
  watching = false;
  if (sends === 0) {
    failures++;
    log.error("no block left to vote in before the flip");
  }
  await Promise.all(sending);
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  const voters = [...(conduits.immutable ? [chain.immutable.conduit] : []), ...(conduits.klima ? [chain.conduit] : [])];
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
 * called, so that a poke, which casts a voter's last vote again, shows as one. A transaction through another contract
 * shows the selector it called on its `to`.
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
  const ours = new Set([chain.conduit, chain.immutable.conduit].map(lower));
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
      const [receipt, tx] = await Promise.all([
        client.getTransactionReceipt({ hash }),
        client.getTransaction({ hash }),
      ]);
      const where = landing(Number(flip) * 1000, await blockOf(receipt.blockNumber), receipt);
      const { from, to, blockNumber: block } = receipt;
      const row = { hash, voter: by, ours: by !== undefined && ours.has(lower(by)), from, to, call: callOf(tx) };
      return { ...row, pools, block, ...where };
    }),
  );
  rows.sort((a, b) => (a.block === b.block ? (a.index ?? 0) - (b.index ?? 0) : a.block < b.block ? -1 : 1));
  for (const row of rows) log.info("vote before the flip", row);
  log.info("votes before the flip", {
    seconds: WATCHED_S,
    votes: rows.length,
    others: rows.filter((r) => !r.ours).length,
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
  for (const { hash, vote, nonce, sender, target, sentAt, gas } of sent) {
    const conduit = lower(sender.conduit);
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
  // Read at the last block before the flip, because anyone can already vote for the immutable conduit in the next
  // epoch.
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

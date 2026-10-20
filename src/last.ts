import {
  keccak256,
  serializeTransaction,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { Blocks, sleep, watch } from "./blocks.ts";
import { lower, readMany, voterCall, WEEK, type Chain } from "./chain.ts";
import { decideV2, pricedPools, readOnchain, readPricedTokens, type Onchain } from "./immutable.ts";
import { errorMessage, log } from "./log.ts";
import type { Prices } from "./prices.ts";
import { tokensOf, valueRewards, type Run } from "./pass.ts";
import { assertFresh, readEpoch, readRewards, readVotes, type PoolRewards, type State } from "./read.ts";
import { expected, select, type Vote } from "./select.ts";
import {
  broadcastTx,
  klimaSender,
  markMined,
  nonceTaken,
  prepareVote,
  v2Sender,
  verifyVote,
  type Prepared,
  type Sender,
} from "./vote.ts";

const WARMUP_MS = 60_000; // the pass starts this long before the flip, to learn the block timing
const PRICES_BY_MS = 5_000; // before the flip
const TICK_MS = 50;
const PLAN_EVERY_MS = 100;
const MAX_PLANS = 3; // in flight
const RETRY_DELAY_MS = 5_000;
const SETTLE_MS = 10_000; // after the flip, so that lagging RPCs have the last blocks

type Sent = { hash: Hex; vote: Vote; nonce: number; sender: Sender };

/**
 * What to send for one conduit in the block with timestamp `time` (ms), from a read at `readAt` (ms). `error` is why
 * a vote that was due could not be prepared.
 */
export type Plan = {
  readAt: number;
  time: number;
  vote: Vote | null;
  note: string;
  prepared?: Prepared;
  error?: string;
  summary: Record<string, unknown>;
};

/** The plans of one read: the Klima conduit's, and the immutable conduit's if the job votes for it. */
type Plans = { readAt: number; time: number; klima: Plan; v2?: Plan | undefined };

type Race<P> = {
  blocks: Blocks;
  plan: (best: P | undefined) => Promise<P>;
  send: (best: P | undefined, time: number) => void;
};

/**
 * Starts a plan every PLAN_EVERY_MS, and sends the freshest plan at the deadline of each of the last two blocks before
 * `flip` (ms). Deadlines come from the block timing alone, so a poll or a plan that hangs delays nothing. Returns the
 * number of sends.
 */
export async function race<P extends { readAt: number }>(
  flip: number,
  { blocks, plan, send }: Race<P>,
  first?: P,
): Promise<number> {
  let best = first;
  let done = false;
  let failure = "";
  let inFlight = 0;
  const planning = async () => {
    for (; !done; await sleep(PLAN_EVERY_MS)) {
      if (inFlight === MAX_PLANS) continue;
      inFlight++;
      void plan(best)
        .then(
          (p) => {
            if (!best || p.readAt > best.readAt) best = p;
          },
          (error: unknown) => {
            if (errorMessage(error) !== failure) log.warning("plan failed", { error: (failure = errorMessage(error)) });
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
    const { gap, lead } = blocks.timing;
    const deadline = time - lead;
    if (!planned && now >= deadline - 2 * gap) {
      planned = true;
      log.info("planning", { block: time / 1000, secondsToDeadline: (deadline - now) / 1000, ...blocks.timing });
      void planning();
    }
    if (now < deadline) {
      await sleep(Math.min(deadline - now, TICK_MS));
      continue;
    }
    after = time;
    send(best, time);
    sends++;
  }
  done = true;
  return sends;
}

/**
 * The Klima conduit's water-filling vote, or null to keep the current one, against everyone else's votes: with the
 * immutable conduit's `v2Votes` on each pool instead of its votes in force, if given.
 */
function decide({ epoch, pools }: State, usd: number[], v2Votes?: bigint[]) {
  const candidates = pools.map((p, i) => ({
    ...p,
    rewardsUsd: usd[i]!,
    otherVotes: p.otherVotes - p.v2Votes + (v2Votes?.[i] ?? p.v2Votes),
  }));
  const { fractions, vote } = select(candidates, epoch.power);
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: candidates[i]!.pool, share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = pools.filter((p) => p.ownVotes > 0n).map((p) => ({ pool: p.pool, votes: p.ownVotes }));
  const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
  return { vote, reason, summary: { plan, expectedUsd, currentVote, power: epoch.power } };
}

/**
 * Votes in each of the last two blocks before the flip, as late as each allows, for the Klima conduit and, if the job
 * votes for it, the immutable one, which plans first: the Klima conduit's vote answers the one it plans. Returns the
 * number of failures.
 */
export async function lastBlocks(run: Run, flip: bigint): Promise<number> {
  const { chain, account, proposer, dryRun } = run;
  const flipMs = Number(flip) * 1000;
  // Prices fetched now are reused if every source fails during the warm-up.
  if (Date.now() < flipMs - WARMUP_MS) {
    await run
      .prices(tokensOf(run), flipMs - WARMUP_MS)
      .catch((error: unknown) => log.warning("prices not fetched ahead", { error: errorMessage(error) }));
  }
  await sleep(Math.max(0, flipMs - WARMUP_MS - Date.now()));
  log.info("last blocks", { flip, secondsToFlip: (flipMs - Date.now()) / 1000 });
  const blocks = new Blocks();
  let watching = true;
  void watch(chain.client, blocks, () => !watching);
  let failures = 0;
  let rewards: PoolRewards[] = [];
  let priced: Prices = new Map();
  let v2Active = false;
  let valued: Address[] = []; // the pools the immutable conduit can value
  // Its values barely move within a block and cost far more gas than the votes, so they are read once per block.
  let onchain: { time: number; values: Promise<Onchain | undefined> } | undefined;
  let onchainFailure = "";
  const onchainAt = (time: number) => {
    if (onchain?.time !== time) {
      const values = readOnchain(chain, valued, "pending").catch((error: unknown) => {
        const message = errorMessage(error);
        if (message !== onchainFailure) log.warning("v2's own values unread", { error: (onchainFailure = message) });
        return undefined;
      });
      onchain = { time, values };
    }
    return onchain.values;
  };

  /** Prepares a conduit's vote for the block at `base.time`, or reuses the one prepared for the same block and vote. */
  const prepare = async (
    base: Plan,
    best: Plan | undefined,
    lastVoted: bigint,
    sender: Sender,
    signer: LocalAccount | undefined,
  ): Promise<Plan> => {
    const { readAt, time, vote } = base;
    if (!vote) return base;
    if (Number(lastVoted) * 1000 >= time) return { ...base, note: "already voted in this block" };
    if (best?.prepared && best.time === time && same(best.vote, vote)) return { ...best, readAt };
    const target = { time: BigInt(Math.floor(time / 1000)), lastVoted };
    return { ...base, prepared: await prepareVote(chain, signer, vote, dryRun, target, sender) };
  };

  const plan = async (best: Plans | undefined, verbose = false): Promise<Plans> => {
    const readAt = Date.now();
    const time = blocks.building(readAt) ?? readAt;
    const [state, values] = await Promise.all([
      readVotes(chain, rewards, "pending"),
      v2Active ? onchainAt(time) : undefined,
    ]);
    assertFresh(state.epoch);
    const usd = valueRewards(run, state.pools, priced, verbose);
    const v2 = v2Active ? decideV2(state, usd, values) : undefined;
    const v2LastVoted = state.epoch.v2?.lastVoted ?? 0n;
    // The Klima conduit answers the vote the immutable conduit plans, unless a vote for it is already in this block:
    // then nobody else's gets in, and the Klima conduit answers the one in force.
    const v2Votes = v2?.vote && Number(v2LastVoted) * 1000 < time ? v2.votes : undefined;
    const klima = decide(state, usd, v2Votes);
    const v2Base = v2 && { readAt, time, vote: v2.vote, note: v2.note, summary: v2.summary };
    const [v2Plan, klimaPlan] = await Promise.all([
      v2Base &&
        prepare(v2Base, best?.v2, v2LastVoted, v2Sender(chain), proposer).catch((error: unknown): Plan => ({
          ...v2Base,
          error: errorMessage(error),
        })),
      prepare(
        { readAt, time, vote: klima.vote, note: klima.reason, summary: klima.summary },
        best?.klima,
        state.epoch.lastVoted,
        klimaSender(chain),
        account,
      ),
    ]);
    return { readAt, time, klima: klimaPlan, v2: v2Plan };
  };

  let first: Plans | undefined;
  while (!first) {
    try {
      const { number, timestamp } = await chain.client.getBlock();
      blocks.observe({ number, timestamp, txs: 0 }, Date.now());
      rewards = await readRewards(chain, tokensOf(run));
      priced = await run.prices(tokensOf(run), flipMs - PRICES_BY_MS);
      if (chain.v2 && !v2Active) {
        // A failure here stops the immutable conduit's votes, not the Klima conduit's.
        await readEpoch(chain)
          .then(async ({ v2 }) => {
            if (!v2?.power) return log.warning("v2 has no voting power this epoch: not voting for it");
            valued = pricedPools(rewards, await readPricedTokens(chain));
            v2Active = true;
          })
          .catch((error: unknown) => {
            failures++;
            log.error("last blocks: v2's warm-up failed, not voting for it", { error: errorMessage(error) });
          });
      }
      first = await plan(undefined, true);
    } catch (error) {
      const retry = Date.now() + RETRY_DELAY_MS < flipMs - PRICES_BY_MS;
      log.error(`last blocks: warm-up failed${retry ? ", retrying" : ""}`, { error: errorMessage(error) });
      if (!retry) {
        watching = false;
        return failures + 1;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Signatures of one transaction differ, so copies of it are found by its unsigned hash.
  const sent = new Map<Hex, Sent>();
  const sending: Promise<void>[] = [];
  const sendOne = (plan: Plan, sender: Sender, at: Record<string, unknown>) => {
    const { conduit } = sender;
    const fields = { conduit, ...at, ageMs: Date.now() - plan.readAt, ...plan.summary };
    if (plan.error) {
      failures++;
      return log.error("vote not prepared", { ...fields, error: plan.error });
    }
    const { prepared } = plan;
    if (!prepared) return log.info(plan.note, fields);
    const { tx, signed } = prepared;
    if (!signed) return log.info("not signed, not sent", fields);
    if (dryRun) return log.info("dry run: signed, not sent", fields);
    const id = keccak256(serializeTransaction(tx));
    if (sent.has(id)) return log.info("already sent", { conduit, ...at });
    sent.set(id, { hash: keccak256(signed), vote: plan.vote!, nonce: tx.nonce, sender });
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
  const send = (best: Plans | undefined, time: number) => {
    const at = { block: time / 1000, secondsToFlip: (flipMs - Date.now()) / 1000 };
    if (!best) {
      failures++;
      log.error("nothing planned in time", at);
      return;
    }
    // The immutable conduit's first, so that its check runs on the state it was simulated on.
    if (best.v2) sendOne(best.v2, v2Sender(chain), at);
    sendOne(best.klima, klimaSender(chain), at);
  };

  const sends = await race(flipMs, { blocks, plan, send }, first);
  watching = false;
  if (sends === 0) {
    failures++;
    log.error("no block left to vote in before the flip");
  }
  await Promise.all(sending);
  await sleep(Math.max(0, flipMs + SETTLE_MS - Date.now()));
  const conduits = [chain.conduit, ...(chain.v2 && v2Active ? [chain.v2.conduit] : [])];
  return failures + (await outcome(run, flip, [...sent.values()], conduits));
}

/** When the Voter last recorded a vote of `conduit`, as of block `blockNumber`. */
async function lastVotedAt(chain: Chain, conduit: Address, blockNumber: bigint): Promise<bigint> {
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [conduit])], { blockNumber });
  return lastVoted!;
}

/**
 * Logs where each sent vote landed, checks the last one of each conduit before the flip, and that the Voter shows a
 * vote of each of `conduits` this epoch. Returns the number of failures.
 */
async function outcome({ chain, dryRun }: Run, flip: bigint, sent: Sent[], conduits: Address[]): Promise<number> {
  let failures = 0;
  const last = new Map<Address, { hash: Hex; vote: Vote; block: bigint; timestamp: bigint }>();
  for (const { hash, vote, nonce, sender } of sent) {
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
      markMined(chain, nonce, sender.from); // so that the claims after the flip do not reuse its nonce
      const block = receipt.blockNumber;
      const fields = { conduit, hash, block, status: receipt.status };
      const { timestamp } = await chain.client.getBlock({ blockNumber: block });
      if (timestamp >= flip) log.warning("vote landed after the flip", fields);
      else if (receipt.status !== "success") {
        // Anyone may vote for the immutable conduit, and the Voter takes one vote of it per block.
        if (conduit !== lower(chain.conduit) && (await lastVotedAt(chain, conduit, block)) === timestamp) {
          log.warning("vote reverted: another vote for the conduit was first in its block", fields);
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
  try {
    const lastVoted = await readMany<bigint>(
      chain.client,
      conduits.map((conduit) => voterCall(chain, "lastVoted", [conduit])),
    );
    conduits.forEach((conduit, i) => {
      const fields = { conduit, lastVoted: lastVoted[i]! };
      const ours = last.get(lower(conduit));
      if (fields.lastVoted < flip - WEEK || fields.lastVoted >= flip) {
        if (dryRun) return log.warning("no vote this epoch", fields);
        failures++;
        return log.error("no vote this epoch", fields);
      }
      log.info("voted this epoch", fields);
      if (ours && fields.lastVoted > ours.timestamp) log.warning("another vote replaced the last one sent", fields);
    });
  } catch (error) {
    log.warning("lastVoted unread", { error: errorMessage(error) });
  }
  return failures;
}

const same = (a: Vote | null, b: Vote) =>
  a !== null && a.pools.join() === b.pools.join() && a.weights.join() === b.weights.join();

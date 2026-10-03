import { readFileSync } from "node:fs";
import { formatUnits, getAddress, type Address, type LocalAccount } from "viem";
import { connect, hostOf, now, readMany, voterCall, WEEK, type Chain, type ReadOptions } from "./chain.ts";
import { runFinal, sleep, within, type Prepared } from "./final.ts";
import { kmsAccount, NoMetadataServer } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import { alchemy, coingecko, combined, defillama, priceFeed, type Prices } from "./prices.ts";
import {
  assertFresh,
  LayoutChanged,
  readEpoch,
  readLayout,
  readPass,
  readVoted,
  type Epoch,
  type Layout,
  type PoolRewards,
} from "./read.ts";
import { HORIZON, schedule } from "./schedule.ts";
import { expected, select, type Candidate, type Vote } from "./select.ts";
import {
  castVote,
  confirmVote,
  costOf,
  prepareVote,
  readFees,
  readNonces,
  rehearse,
  sendVote,
  voteData,
  VoteSent,
  type Fees,
  type Nonces,
  type Signed,
} from "./vote.ts";
import { parseWhitelist, type Whitelist } from "./whitelist.ts";

// Tried after BASE_RPC_URLS. Rate-limited: Base calls its own "not suitable for production apps".
const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const LAST_MARGIN_MS = 2_000;
const PREPARE_S = 60; // prices, a rehearsal and a signed fallback vote this long before the flip; under MIN_LEAD in sh/lib.sh
const ARM_S = 20; // the pending block is watched from this long before the flip
const PRICES_MS = 20_000;
const MIN_READ_MS = 150;
const MIN_SIGN_MS = 200;

type Run = {
  chain: Chain;
  whitelist: Whitelist;
  layout?: Layout;
  prices: ReturnType<typeof priceFeed>;
  account: LocalAccount | undefined;
  dryRun: boolean;
};

type Rewards = { epoch: Epoch; rewards: PoolRewards[] };

type Read = Rewards & { nonces: Nonces; fees: Fees; balance: bigint; gas: bigint | undefined };

async function readRewards(run: Run, at: ReadOptions): Promise<Rewards> {
  const { chain, whitelist } = run;
  const pools = whitelist.map((w) => w.pool);
  run.layout ??= await readLayout(chain, pools);
  try {
    return await readPass(chain, run.layout, at);
  } catch (error) {
    if (!(error instanceof LayoutChanged)) throw error;
    log.info("reward tokens changed, re-reading");
    run.layout = await readLayout(chain, pools);
    return readPass(chain, run.layout, at);
  }
}

/** A vote over every pool with a gauge: no vote costs more gas. */
const sized = ({ layout }: Run): Vote | undefined =>
  layout && { pools: layout.pools, weights: layout.pools.map(() => 1n) };

/** One round trip: the pending state, the nonces, the fees, the balance and the gas of the largest vote. */
async function readAll(run: Run): Promise<Read> {
  const { chain } = run;
  const { client, keeper, module } = chain;
  void readVoted(chain).then(
    (voted) => voted.length && log.info("votes in the block being built", { voted }),
    (error: unknown) => log.warning("pending votes unread", { error: errorMessage(error) }),
  );
  const largest = sized(run);
  const [rewards, nonces, fees, balance, gas] = await Promise.all([
    readRewards(run, { blockTag: "pending" }),
    readNonces(chain),
    readFees(client),
    client.getBalance({ address: keeper }),
    largest &&
      client.estimateGas({ account: keeper, to: module, data: voteData(largest), blockTag: "pending" }).then(
        (gas) => (gas * 12n) / 10n,
        () => undefined,
      ),
  ]);
  return { ...rewards, nonces, fees, balance, gas };
}

/** The candidates and the vote to cast, if any. */
function evaluate(
  run: Run,
  { epoch, rewards }: Rewards,
  priced: Prices,
): { vote: Vote | null; candidates: Candidate[] } {
  assertFresh(epoch);
  if (epoch.power === 0n) throw new Error("conduit has no voting power this epoch");
  const { whitelist } = run;
  const candidates: Candidate[] = [];
  const nameOf = (pool: Address) => whitelist.find((w) => w.pool === pool)?.name ?? pool;
  for (const p of rewards) {
    const pool = nameOf(p.pool);
    const detail = p.rewards.map((r) => {
      const price = priced.get(r.token.toLowerCase() as Address);
      const amount = Number(formatUnits(r.amount, r.decimals));
      return { token: r.token, amount, usd: price === undefined ? null : amount * price };
    });
    const unpriced = detail.filter((d) => d.usd === null);
    if (unpriced.length) log.warning("unpriced rewards count as zero", { pool, unpriced });
    const rewardsUsd = detail.reduce((sum, d) => sum + (d.usd ?? 0), 0);
    const candidate = { pool: p.pool, rewardsUsd, otherVotes: p.otherVotes, ownVotes: p.ownVotes };
    if (p.alive) candidates.push(candidate);
    else log.warning("gauge is dead, skipping", { pool });
    log.info("candidate", { ...candidate, pool, alive: p.alive, rewards: detail });
  }

  if (candidates.length === 0) throw new Error("no whitelisted pool has a live gauge");
  const { fractions, vote } = select(candidates, epoch.power);
  const plan = (fractions ?? [])
    .map((f, i) => ({ pool: nameOf(candidates[i]!.pool), share: Math.round(f * 10_000) / 100 }))
    .filter((p) => p.share > 0);
  const expectedUsd = fractions ? expected(candidates, fractions, epoch.power) : 0;
  const currentVote = rewards.filter((p) => p.ownVotes > 0n).map((p) => ({ pool: nameOf(p.pool), votes: p.ownVotes }));
  if (!vote) {
    const reason = fractions ? "keeping the current vote" : "no pool pays anything; keeping the current vote";
    log.info(reason, { plan, expectedUsd, currentVote });
  } else log.info("voting", { plan, expectedUsd, currentVote, power: epoch.power });
  return { vote, candidates };
}

const tokensOf = ({ rewards }: Rewards) => rewards.flatMap((p) => p.rewards.map((r) => r.token));

async function pass(run: Run, until: number): Promise<void> {
  const read = await readRewards(run, { blockTag: "pending" });
  const tokens = tokensOf(read);
  const priced = await run.prices(tokens, until);
  if (priced.size === 0 && tokens.length > 0) throw new Error("no reward token could be priced");
  const { vote } = evaluate(run, read, priced);
  if (vote) await castVote(run.chain, run.account, vote, run.dryRun, until);
}

type Rehearsed = Prepared<Read, Signed> & { priced: Prices; gasMax?: bigint; l1Fee?: bigint };

/** A first read, its rewards' prices, the gas of the largest vote, and a signed vote to fall back on; each best effort. */
async function prepare(run: Run, flip: bigint): Promise<Rehearsed> {
  const { chain, account } = run;
  const until = (Number(flip) - ARM_S) * 1000;
  const out: Rehearsed = { readMs: MIN_READ_MS, signMs: MIN_SIGN_MS, priced: new Map() };
  let started = Date.now();
  try {
    run.layout ??= await within(
      readLayout(
        chain,
        run.whitelist.map((w) => w.pool),
      ),
      until,
    );
    out.snapshot = await within(readAll(run), until);
    out.readMs = Math.max(MIN_READ_MS, Date.now() - started);
    out.priced = await run.prices(tokensOf(out.snapshot), Math.min(until, Date.now() + PRICES_MS));
    const { vote } = evaluate(run, out.snapshot, out.priced);
    const largest = sized(run)!;
    const { gas, balance, l1Fee } = await within(rehearse(chain, vote ?? largest, largest), until);
    out.gasMax = gas;
    out.l1Fee = l1Fee;
    const { fees, nonces } = out.snapshot;
    const cost = gas * (fees.baseFee * 2n + fees.tip) + l1Fee;
    if (balance < 2n * cost) log.error("fund the keeper", { keeper: chain.keeper, balance, cost });
    log.info("rehearsed", { gasMax: gas, readMs: out.readMs, fallback: Boolean(vote && account) });
    if (!vote || !account) return out;
    const tx = prepareVote(chain, vote, gas, nonces, fees, 4n);
    started = Date.now();
    const signed = await within(account.signTransaction(tx), until);
    out.signMs = Math.max(MIN_SIGN_MS, Date.now() - started);
    out.fallback = { vote, signed: { tx, signed } };
  } catch (error) {
    log.error("rehearsal cut short", { error: errorMessage(error) });
  }
  return out;
}

/** Votes in the last two blocks before the flip; true if the conduit has voted this epoch afterwards. */
async function finalPhase(run: Run, flip: bigint): Promise<boolean> {
  const { chain, account, dryRun } = run;
  const { client, keeper, module, conduit } = chain;
  await sleep(Math.max(0, (Number(flip) - PREPARE_S) * 1000 - Date.now()));
  const prepared = await prepare(run, flip);
  await sleep(Math.max(0, (Number(flip) - ARM_S) * 1000 - Date.now()));
  const seeds = await client.getBlock().then(
    (block) => [Number(block.timestamp)],
    () => [],
  );
  let signedOver = 0n; // the conduit's lastVoted at the last signature
  let last: { nonce: number; lastVoted: bigint } | undefined; // the vote sent, and lastVoted before it
  const sent = await runFinal<Read, Signed>(
    Number(flip),
    {
      poll: async () => {
        const [latest, pending] = await Promise.all([client.getBlock(), client.getBlock({ blockTag: "pending" })]);
        if (pending.timestamp <= latest.timestamp) throw new Error("no block being built");
        return { timestamp: Number(pending.timestamp) };
      },
      read: () => readAll(run),
      decide: (read) => evaluate(run, read, prepared.priced).vote,
      sign: async (vote, read) => {
        if (!account) return (log.warning("signing skipped: no KMS key configured"), undefined);
        const estimate = () =>
          client.estimateGas({ account: keeper, to: module, data: voteData(vote), blockTag: "pending" });
        const gas = read.gas ?? prepared.gasMax ?? ((await estimate()) * 12n) / 10n;
        const mined = last !== undefined && read.epoch.lastVoted > last.lastVoted ? last.nonce + 1 : 0;
        const nonces = { latest: Math.max(read.nonces.latest, mined), pending: Math.max(read.nonces.pending, mined) };
        const tx = prepareVote(chain, vote, gas, nonces, read.fees);
        const cost = costOf(tx, prepared.l1Fee ?? 0n);
        if (read.balance < cost)
          throw new Error(`fund the keeper: ${keeper} has ${read.balance} wei, the vote costs ${cost}`);
        const { nonce, maxFeePerGas, maxPriorityFeePerGas } = tx;
        log.info("vote prepared", {
          pools: vote.pools,
          weights: vote.weights,
          gas,
          nonce,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        signedOver = read.epoch.lastVoted;
        try {
          return { tx, signed: await account.signTransaction(tx) };
        } catch (error) {
          if (!dryRun || !(error instanceof NoMetadataServer)) throw error;
          return (log.warning("signing skipped: no metadata server", { reason: error.message }), undefined);
        }
      },
      send: async (signed, until) => {
        if (dryRun) return (log.info("dry run: signed, not sent"), undefined);
        last = { nonce: signed.tx.nonce, lastVoted: signedOver };
        const hash = await sendVote(chain, signed, until);
        log.info("vote sent", { hash });
        return hash;
      },
    },
    prepared,
    seeds,
  );
  const own = new Set(sent.map((s) => s.hash));
  const results = await Promise.allSettled(sent.map((s) => confirmVote(chain, s.vote, s.hash, own)));
  for (const result of results) {
    if (result.status === "rejected") log.error("vote not confirmed", { error: errorMessage(result.reason) });
  }
  let voted = results.some((r) => r.status === "fulfilled");
  try {
    const [lastVoted] = await readMany<bigint>(client, [voterCall(chain, "lastVoted", [conduit])]);
    voted = lastVoted! >= flip - WEEK && lastVoted! < flip;
    log[voted ? "info" : "error"](voted ? "voted this epoch" : "no vote this epoch", { lastVoted, flip });
  } catch (error) {
    log.warning("lastVoted unread; going by the confirmations", { voted, error: errorMessage(error) });
  }
  return dryRun || voted;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const immediately = process.argv.includes("--now");
  const module = getAddress(required("MODULE"));
  const keyVersion = dryRun ? process.env.KMS_KEY_VERSION : required("KMS_KEY_VERSION");
  const offsetFields = immediately ? [] : required("VOTE_OFFSETS").split(",");
  if (!offsetFields.every((s) => /^[0-9]+$/.test(s))) throw new Error("VOTE_OFFSETS must be comma-separated seconds");
  const offsets = offsetFields.map(BigInt);
  const whitelist = parseWhitelist(readFileSync(new URL("../pools.json", import.meta.url), "utf8"));

  const configured = required("BASE_RPC_URLS").split(",");
  const rpcUrls = [...new Set([...configured, ...PUBLIC_RPCS].map((url) => url.trim()).filter(Boolean))];
  const chain = await connect(module, rpcUrls);
  const account = keyVersion ? kmsAccount(keyVersion, chain.keeper) : undefined;
  const { ALCHEMY_API_KEY: alchemyKey, COINGECKO_API_KEY: coingeckoKey } = process.env;
  const source = combined([
    defillama(),
    ...(alchemyKey ? [alchemy(alchemyKey)] : []),
    ...(coingeckoKey ? [coingecko(coingeckoKey)] : []),
  ]);
  const { keeper, conduit, voter } = chain;
  log.info("keeper", { module, keeper, conduit, voter, rpcs: rpcUrls.map(hostOf), prices: source.name, dryRun });

  const epoch = await readEpoch(chain);
  if (!immediately && epoch.flip <= now() && now() - epoch.flip < HORIZON) {
    log.warning("restarted after the flip; nothing to do", { flip: epoch.flip });
    return 0;
  }
  assertFresh(epoch);
  const { flip } = epoch;
  const { times: due, final, note } = schedule(flip, offsets, now(), immediately);
  if (note) log.warning(note, { flip });
  const deadline = Number(flip) * 1000 - (final ? PREPARE_S * 1000 : LAST_MARGIN_MS);
  const times = due.filter((time) => Number(time) * 1000 < deadline);
  if (times.length < due.length)
    log.warning("passes within the last blocks' window skipped", { at: due.slice(times.length) });
  if (times.length === 0 && !final) return 0;
  const run: Run = { chain, whitelist, prices: priceFeed(source), account, dryRun };

  let failed = 0;
  for (const [i, time] of times.entries()) {
    await sleep(Math.max(0, Number(time) * 1000 - Date.now()));
    const until = i + 1 < times.length ? Number(times[i + 1]!) * 1000 : deadline;
    if (Date.now() >= until) {
      log.warning("pass skipped, overdue", { at: time, secondsToFlip: flip - now() });
      continue;
    }
    log.info("pass", { at: time, flip, secondsToFlip: flip - now() });
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        await pass(run, until);
        log.info("pass done", { ms: Date.now() - started, secondsToFlip: flip - now() });
        break;
      } catch (error) {
        const ms = Date.now() - started;
        const retry = attempt < ATTEMPTS && !(error instanceof VoteSent) && Date.now() + RETRY_DELAY_MS < until;
        log.error(`pass failed${retry ? ", retrying" : ""}`, { attempt, ms, error: errorMessage(error) });
        if (!retry) {
          failed++;
          break;
        }
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  if (final && !(await finalPhase(run, flip))) failed++;
  return failed ? 1 : 0;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error("fatal", { error: errorMessage(error) });
    process.exit(1);
  },
);

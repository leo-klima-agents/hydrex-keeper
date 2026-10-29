import {
  formatEther,
  formatUnits,
  isAddressEqual,
  parseEther,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type Log,
} from "viem";
import { conduitAbi, immutableAbi, retirementAbi, veAbi } from "./abi.ts";
import { sleep } from "./blocks.ts";
import { blockAtLeast, call, lower, readEach, readMany, WEEK, WETH, type Call, type Chain } from "./chain.ts";
import { BadSwap, kyberswap, SwapRefused, type Swap, type Swapper } from "./kyber.ts";
import { errorMessage, log } from "./log.ts";
import { tokensOf, type Run } from "./pass.ts";
import type { Prices } from "./prices.ts";
import { bribeCall, readBribes, readDecimals, readEpoch, readRewardTokens, type Bribe, type Reader } from "./read.ts";
import {
  broadcastTx,
  confirmTx,
  klimaSender,
  prepareCall,
  signTx,
  Unconfirmed,
  v2Sender,
  type ModuleCall,
  type Sender,
} from "./vote.ts";

/** Only for the Klima conduit's claims. */
export const EXCLUDED_OWNERS: ReadonlyMap<string, string> = new Map([
  ["0xa79cd47655156b299762dfe92a67980805ce5a31", "Klima Foundation"],
]);

export const MIN_CLAIM_USD = 5;
export const MAX_GAS_SHARE = 0.05;
const LOOKBACK = 12;
const SLIPPAGE_BPS = 500;
const MAX_SWAP_LOSS = 0.15;
const RETIRE_PERCENT = 97n;
const RESERVE = parseEther("0.001"); // kept in the keeper or the proposer for the next votes
const MARGIN_MS = 60_000;
// Rough gas costs for planning a claim. The simulation has the final say.
const BASE_GAS = 1_300_000n;
const V2_BASE_GAS = 400_000n;
const SWAP_GAS = 800_000n;
const PAIR_GAS = 300_000n;
const GAS_BUDGET = 10_000_000n;
const MAX_GAS_USED = 12_000_000n; // a claim can need a third more gas than it uses, and Base allows 16.8M
const REPLANS = 4;
const ROUNDS = 12;
const EARNED_CHUNK = 25; // earned() loops over every epoch since the last claim, so 25 calls can use 15M gas
const WINDOW = 50n; // earned() only looks this many epochs past the last claim
const CONCURRENCY = 4;
const MINTER_POLL_MS = 5_000;
const READ_TRIES = 3;
const READ_RETRY_MS = 5_000;
const TONNE = 10n ** 18n;

/**
 * What one bribe contract owes a veNFT in one token, in USD. `later` is owed too, but lies past the epochs earned()
 * looks at, and claiming the pair makes it claimable right after.
 */
export type Pair = { bribe: Address; fees: boolean; token: Address; usd: number; later?: number };

type Paying = Pick<Pair, "bribe" | "fees" | "token">;

/** A claim asks every contract in `fees` and `bribes` for every token in `tokens`. */
export type ClaimPlan = { tokens: Address[]; fees: Address[]; bribes: Address[]; usd: number; gas: bigint };

type Conduit = { sender: Sender; signer: LocalAccount | undefined; excluded: ReadonlyMap<string, string> };

type Market = { decimals: Map<string, number>; priced: Prices; gasPrice: bigint };

/** `delegatees` is indexed by veNFT id minus one. */
type Shared = { delegatees: () => Promise<Address[]>; bribes: () => Promise<Bribe[]>; market: () => Promise<Market> };

type Klima = {
  kvcm: Address;
  /** Tokens the conduit pays out as they are, without a swap. */
  payouts: Address[];
  retireBps: bigint;
  aggregator: Address;
  creditToken: Address;
  creditTokenId: bigint;
  carbonClass: Address;
};

type Nft = {
  id: bigint;
  owner: Address;
  pairs: Pair[];
  taken: Set<string>;
  /** The most of a token, in USD, that a claim may take, because a larger swap of it lost too much. */
  caps: Map<Address, number>;
  unswapped: Set<string>;
  /** Claims a dry run built but didn't send. The next simulation runs them first. */
  prepared: ModuleCall[];
  /** Pairs that only those claims took. The chain still shows them as owed. */
  simulated: Set<string>;
  /** Pairs a claim left owing, which are claimed once more. */
  reopened: Set<string>;
};

type Context = Run &
  Conduit & {
    /** Undefined for the immutable conduit, which pays out every token as it is and retires nothing. */
    klima: Klima | undefined;
    swapper: Swapper;
    priced: Prices;
    decimals: Map<string, number>;
    ethUsd: number;
    usdPerGas: number;
    until: number;
    unswapped: Set<string>;
    anomalies: number;
    /** The block of the last claim sent. A node behind it would still show that claim's rewards as owed. */
    pinned?: bigint;
  };

type Refusal = { token: Address; why: "route" | "loss" | "answer"; reason: string; usd: number };

type Built = {
  call: Extract<ModuleCall, { functionName: "claimSwapAndDistribute" | "claim" }>;
  usd: number;
  swaps: { token: Address; amountIn: bigint; quoted: bigint; minOut: bigint }[];
  retirement?: { retireTonnes: bigint; maxKvcmIn: bigint };
};

/** Stops all remaining claims, not just this veNFT's. */
class Stop extends Error {}

const pairKey = (bribe: Address, token: Address) => `${lower(bribe)}${lower(token)}`;

const isPayout = ({ payouts }: Klima, token: Address) => payouts.some((payout) => isAddressEqual(payout, token));

const swapped = ({ klima }: Context, token: Address) => klima !== undefined && !isPayout(klima, token);

const veCall = ({ ve }: Chain, functionName: string, args?: readonly unknown[]) => call(ve, veAbi, functionName, args);

const conduitCall = ({ conduit }: Chain, functionName: string, args?: readonly unknown[]) =>
  call(conduit, conduitAbi, functionName, args);

const worth = (p: Pair) => p.usd + (p.later ?? 0);

export const worthClaiming = (usd: number, gasUsd: number) => usd >= MIN_CLAIM_USD && gasUsd <= usd * MAX_GAS_SHARE;

/**
 * The most valuable claim that fits in `budget` gas, for a conduit whose claims cost `baseGas` before swaps and
 * contracts. It tries the most valuable token, then the top two, and so on, each with the contracts that pay the most.
 * A contract is left out if it doesn't pay for its gas or would take a token past its cap.
 */
export function planClaim(
  pairs: Pair[],
  budget: bigint,
  usdPerGas: number,
  swapped: (token: Address) => boolean,
  caps: ReadonlyMap<Address, number> = new Map(),
  baseGas = BASE_GAS,
): ClaimPlan | undefined {
  const totals = new Map<Address, number>();
  for (const p of pairs) totals.set(p.token, (totals.get(p.token) ?? 0) + worth(p));
  const ranked = [...totals]
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token);
  // Also try without the capped tokens, because a contract left out for a cap may still be worth claiming for its other
  // tokens.
  const rankings = caps.size ? [ranked, ranked.filter((token) => !caps.has(token))] : [ranked];
  let best: ClaimPlan | undefined;
  for (const order of rankings) {
    for (let k = 1; k <= order.length; k++) {
      const tokens = order.slice(0, k);
      const perBribe = BigInt(k) * PAIR_GAS;
      const fixed = baseGas + BigInt(tokens.filter(swapped).length) * SWAP_GAS;
      if (budget - fixed < perBribe) break;
      const contracts = new Map<Address, { fees: boolean; usd: number; byToken: Map<Address, number> }>();
      for (const p of pairs) {
        if (!tokens.includes(p.token)) continue;
        const contract = contracts.get(p.bribe) ?? { fees: p.fees, usd: 0, byToken: new Map<Address, number>() };
        contract.usd += worth(p);
        // Caps limit what is swapped now, so `later` doesn't count toward them.
        contract.byToken.set(p.token, (contract.byToken.get(p.token) ?? 0) + p.usd);
        contracts.set(p.bribe, contract);
      }
      const room = Number((budget - fixed) / perBribe);
      const floor = (Number(perBribe) * usdPerGas) / MAX_GAS_SHARE;
      const taken = new Map<Address, number>();
      const kept: [Address, boolean][] = [];
      let usd = 0;
      for (const [bribe, contract] of [...contracts].sort((a, b) => b[1].usd - a[1].usd)) {
        if (kept.length === room || contract.usd < floor) break;
        const capped = [...contract.byToken].some(([t, v]) => (taken.get(t) ?? 0) + v > (caps.get(t) ?? Infinity));
        if (capped) continue;
        for (const [t, v] of contract.byToken) taken.set(t, (taken.get(t) ?? 0) + v);
        kept.push([bribe, contract.fees]);
        usd += contract.usd;
      }
      if (kept.length === 0 || (best && usd <= best.usd)) continue;
      best = {
        tokens,
        fees: kept.flatMap(([bribe, fees]) => (fees ? [bribe] : [])),
        bribes: kept.flatMap(([bribe, fees]) => (fees ? [] : [bribe])),
        usd,
        gas: fixed + BigInt(kept.length) * perBribe,
      };
    }
  }
  return best;
}

/** The two conduits claim at the same time, each with its own key, and one failing doesn't stop the other. */
export async function claims(run: Run, flip: bigint, until: number, swapper: Swapper = kyberswap()): Promise<number> {
  const { chain, account, proposer } = run;
  let start: bigint;
  try {
    start = await started(chain, flip, until);
  } catch (error) {
    log.error("claims failed", { error: errorMessage(error) });
    return 1;
  }
  const conduits: Conduit[] = [
    { sender: klimaSender(chain), signer: account, excluded: EXCLUDED_OWNERS },
    ...(chain.v2 ? [{ sender: v2Sender(chain), signer: proposer, excluded: new Map() }] : []),
  ];
  const shared: Shared = {
    delegatees: sharedRead(() => readDelegatees(chain, start - WEEK)),
    bribes: sharedRead(() => readContracts(chain)),
    market: sharedRead(() => readMarket(run, marketTokens(run), until)),
  };
  const failures = await Promise.all(
    conduits.map((conduit) =>
      claimRewards(run, conduit, shared, start, until, swapper).catch((error: unknown) => {
        log.error("claims failed", { conduit: conduit.sender.conduit, error: errorMessage(error) });
        return 1;
      }),
    ),
  );
  return failures.reduce((sum, n) => sum + n, 0);
}

/**
 * Starts `read` at once and shares it with every caller while it is pending or after it succeeds, so that both conduits
 * use one read whenever each asks. After a failure, the next caller starts a new read, which is shared in turn.
 */
function sharedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let reading: Promise<T> | undefined;
  const start = () => {
    const current = read();
    // Callers handle failures. This keeps a read that nobody asked for from becoming an unhandled rejection.
    current.catch(() => {
      if (reading === current) reading = undefined;
    });
    return (reading = current);
  };
  start();
  return () => reading ?? start();
}

async function tried<T>(read: () => Promise<T>, what: string, conduit: Address): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === READ_TRIES) throw error;
      log.warning(`${what} failed, retrying`, { conduit, attempt, error: errorMessage(error) });
      await sleep(READ_RETRY_MS);
    }
  }
}

const marketTokens = (run: Run) => [...new Map([...tokensOf(run), WETH].map((t) => [lower(t), t])).values()];

async function readMarket({ chain, prices }: Run, tokens: Address[], until: number): Promise<Market> {
  const [decimals, priced, gasPrice] = await Promise.all([
    readDecimals(chain.bulk, tokens),
    prices(tokens, until),
    chain.client.getGasPrice(),
  ]);
  return { decimals, priced, gasPrice };
}

async function started(chain: Chain, flip: bigint, until: number): Promise<bigint> {
  for (;;) {
    const epoch = await readEpoch(chain).catch((error: unknown) => {
      log.warning("epoch unread", { error: errorMessage(error) });
      return undefined;
    });
    if (epoch && epoch.start >= flip) return epoch.start;
    if (Date.now() + MINTER_POLL_MS >= until) throw new Error(`the minter has not started the epoch at ${flip}`);
    await sleep(MINTER_POLL_MS);
  }
}

async function claimRewards(
  run: Run,
  conduit: Conduit,
  shared: Shared,
  start: bigint,
  until: number,
  swapper: Swapper,
): Promise<number> {
  const { conduit: address } = conduit.sender;
  // Retried, because a failed read would otherwise push the claims to next week: a retry of the scheduled run starts
  // after the claim hour.
  const read = () => readClaims(run, conduit, shared, start, until, swapper);
  const { ctx, nfts } = await tried(read, "the claims' reads", address);
  let sent = 0;
  let failures = 0;
  // Each claim takes at least one pair that no earlier claim took, or reopens one at most once, so a veNFT always runs
  // out of claims.
  claiming: for (const [i, nft] of nfts.entries()) {
    for (;;) {
      if (until - Date.now() < MARGIN_MS) {
        // What a claim of this run unlocked would otherwise have waited a week, so it fails nothing.
        const left = nfts
          .slice(i)
          .filter((rest) => (nextPlan(ctx, rest, GAS_BUDGET, false)?.usd ?? 0) >= MIN_CLAIM_USD);
        if (left.length) {
          failures++;
          log.error("out of time: claims left for the next ones", {
            conduit: address,
            tokenIds: left.map(({ id }) => id),
          });
        }
        break claiming;
      }
      try {
        if (!(await claimOnce(ctx, nft))) break;
        sent++;
      } catch (error) {
        failures++;
        log.error("claim failed", { conduit: address, tokenId: nft.id, error: errorMessage(error) });
        if (error instanceof Stop) break claiming;
        break;
      }
    }
  }
  log.info("claims done", { conduit: address, claims: sent, failures, anomalies: ctx.anomalies });
  return failures + ctx.anomalies;
}

async function readClaims(
  run: Run,
  conduit: Conduit,
  shared: Shared,
  start: bigint,
  until: number,
  swapper: Swapper,
): Promise<{ ctx: Context; nfts: Nft[] }> {
  const { chain } = run;
  const { conduit: address } = conduit.sender;
  const ended = start - WEEK;
  const epochs = Array.from({ length: LOOKBACK }, (_, k) => ended - BigInt(k) * WEEK);
  const [klima, delegators] = await Promise.all([
    isAddressEqual(address, chain.conduit) ? readKlima(chain) : undefined,
    shared.delegatees().then((delegatees) => readDelegators(chain, address, ended, delegatees)),
  ]);
  const nfts = delegators.flatMap(({ id, owner, approved }): Nft[] => {
    const excluded = owner && conduit.excluded.get(lower(owner));
    const fields = { conduit: address, tokenId: id };
    if (!owner) log.info("not claimed: burned", fields);
    else if (excluded) log.info("not claimed: excluded owner", { ...fields, owner, name: excluded });
    else if (!approved) log.warning("not claimed: the conduit may not claim for it", { ...fields, owner });
    else return [newNft(id, owner)];
    return [];
  });
  // The Klima conduit's claims also need kVCM's price, which the whitelist normally includes.
  const tokens = marketTokens(run);
  const unlisted = klima && !tokens.some((token) => isAddressEqual(token, klima.kvcm));
  const [paying, { decimals, priced, gasPrice }] = await Promise.all([
    shared.bribes().then((bribes) => readPayingPairs(chain, address, bribes, tokensOf(run), epochs)),
    unlisted ? readMarket(run, [...tokens, klima.kvcm], until) : shared.market(),
  ]);
  const ethUsd = priced.get(lower(WETH));
  if (ethUsd === undefined) throw new Error("ETH has no price");
  if (klima && !priced.has(lower(klima.kvcm))) throw new Error("kVCM has no price");
  const ctx: Context = {
    ...run,
    ...conduit,
    klima,
    swapper,
    priced,
    decimals,
    ethUsd,
    usdPerGas: Number(formatEther(gasPrice)) * ethUsd,
    until,
    unswapped: new Set(),
    anomalies: 0,
  };
  const [earned, hidden] = await Promise.all([
    readMany<bigint>(
      chain.bulk,
      nfts.flatMap(({ id }) => paying.map(({ bribe, token }) => bribeCall(bribe, "earned", [id, token]))),
      { chunk: EARNED_CHUNK, concurrency: CONCURRENCY },
    ),
    readHidden(chain, nfts, paying, start),
  ]);
  nfts.forEach((nft, i) => {
    nft.pairs = paying.flatMap((p, j) => {
      const amount = earned[i * paying.length + j]!;
      const later = hidden[i]!.get(pairKey(p.bribe, p.token)) ?? 0n;
      if (amount === 0n && later === 0n) return [];
      return [{ ...p, usd: valueOf(ctx, p.token, amount), later: valueOf(ctx, p.token, later) }];
    });
  });
  const total = ({ pairs }: Nft) => pairs.reduce((sum, p) => sum + worth(p), 0);
  nfts.sort((a, b) => total(b) - total(a));
  log.info("claims", {
    conduit: address,
    epoch: ended,
    delegators: delegators.length,
    claimable: nfts.length,
    pairs: paying.length,
  });
  for (const nft of nfts) {
    log.info("delegator", { conduit: address, tokenId: nft.id, owner: nft.owner, usd: total(nft) });
  }
  return { ctx, nfts };
}

const newNft = (id: bigint, owner: Address): Nft => ({
  id,
  owner,
  pairs: [],
  taken: new Set(),
  caps: new Map(),
  unswapped: new Set(),
  prepared: [],
  simulated: new Set(),
  reopened: new Set(),
});

const untaken = (nft: Nft) => nft.pairs.filter((p) => !nft.taken.has(pairKey(p.bribe, p.token)));

function nextPlan(ctx: Context, nft: Nft, budget = GAS_BUDGET, reopened = true): ClaimPlan | undefined {
  const pairs = untaken(nft).filter(
    (p) =>
      !ctx.unswapped.has(lower(p.token)) &&
      !nft.unswapped.has(lower(p.token)) &&
      (reopened || !nft.reopened.has(pairKey(p.bribe, p.token))),
  );
  const baseGas = ctx.klima ? BASE_GAS : V2_BASE_GAS;
  return planClaim(pairs, budget, ctx.usdPerGas, (token) => swapped(ctx, token), nft.caps, baseGas);
}

async function claimOnce(ctx: Context, nft: Nft): Promise<boolean> {
  const { chain, sender, signer, dryRun, until } = ctx;
  const which = { conduit: sender.conduit, tokenId: nft.id };
  let budget = GAS_BUDGET;
  let replans = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const plan = nextPlan(ctx, nft, budget);
    // Under a reduced budget, no plan means the claim is too large, unless nothing worth claiming is left.
    if (!plan && budget < GAS_BUDGET && (nextPlan(ctx, nft)?.usd ?? 0) >= MIN_CLAIM_USD) {
      throw new Error(`no claim fits in ${MAX_GAS_USED} gas`);
    }
    if (!plan || plan.usd < MIN_CLAIM_USD) {
      const usd = untaken(nft).reduce((sum, p) => sum + worth(p), 0);
      log.info("not claimed: too little", { ...which, claimable: plan?.usd ?? 0, left: usd });
      return false;
    }
    const at = await blockAtLeast(chain, ctx.pinned);
    const built = await buildClaim(ctx, nft, plan, at);
    if (Array.isArray(built)) {
      for (const refusal of built) refuse(ctx, nft, refusal);
      continue;
    }
    const { tx, cost, expectedCost, balance, queued, simulated } = await prepareCall(chain, built.call, {
      before: nft.prepared,
      at,
      sender,
    });
    // A pending transaction may be a vote, and a claim must never replace a vote.
    if (queued) throw new Stop(`a transaction of the ${sender.name} is pending at nonce ${tx.nonce}: the claims stop`);
    if (simulated.gasUsed > MAX_GAS_USED) {
      if (++replans === REPLANS)
        throw new Error(`no claim fits in ${MAX_GAS_USED} gas: ${REPLANS} smaller plans did not`);
      log.info("claim too large, planning a smaller one", {
        ...which,
        gasUsed: simulated.gasUsed,
        plan: plan.gas,
      });
      // Shrink from the plan's gas, not the budget, because a plan well under the budget would come back unchanged.
      budget = (plan.gas * MAX_GAS_USED * 9n) / (simulated.gasUsed * 10n);
      continue;
    }
    checkTaken(ctx, simulated.logs, built);
    const { fees, bribes, tokens } = plan;
    const asked = [...fees, ...bribes];
    const unlocked = untaken(nft)
      .filter((p) => asked.includes(p.bribe) && tokens.includes(p.token))
      .reduce((sum, p) => sum + (p.later ?? 0), 0);
    const gasUsd = Number(formatEther(expectedCost)) * ctx.ethUsd;
    const fields = {
      ...which,
      owner: nft.owner,
      usd: built.usd,
      unlocked,
      gasUsd,
      tokens,
      fees,
      bribes,
      swaps: built.swaps,
      ...built.retirement,
      gasPlanned: plan.gas,
      gasUsed: simulated.gasUsed,
    };
    if (!worthClaiming(built.usd + unlocked, gasUsd)) {
      log.info("not claimed: not worth its gas", fields);
      return false;
    }
    const needed = cost + RESERVE;
    if (balance < needed) {
      throw new Stop(
        `fund the ${sender.name}: ${sender.from} has ${balance} wei, needs ${needed}: a claim costs up to ${cost}`,
      );
    }
    log.info("claim prepared", { ...fields, gas: tx.gas, nonce: tx.nonce, tip: tx.maxPriorityFeePerGas });
    const prepared = await signTx(signer, tx, dryRun, sender.from);
    const { signed } = prepared;
    const pairs = asked.flatMap((bribe) => tokens.map((token) => pairKey(bribe, token)));
    if (!signed || dryRun) {
      log.info(signed ? "dry run: signed, not sent" : "not signed, not sent", which);
      nft.prepared.push(built.call);
      for (const pair of pairs) (nft.simulated.add(pair), nft.taken.add(pair));
    } else {
      const hash = await broadcastTx(chain, { ...prepared, signed }, until).catch((error: unknown) => {
        throw new Stop(`claim not sent: ${errorMessage(error)}`);
      });
      log.info("claim sent", { ...which, hash });
      ctx.pinned = await confirm(ctx, nft.id, hash, tx.nonce);
      await settle(ctx, nft, plan, ctx.pinned);
    }
    return true;
  }
  throw new Error(`no claim fit: ${ROUNDS} plans`);
}

/**
 * A claim moves the epochs earned() reads, so a pair can still owe after it. Such a pair is claimed once more, and only
 * once, in case its contract never pays.
 */
async function settle(ctx: Context, nft: Nft, { fees, bribes, tokens }: ClaimPlan, at: bigint): Promise<void> {
  const asked = [...fees, ...bribes].flatMap((bribe) => tokens.map((token) => ({ bribe, token })));
  const owed = await readMany<bigint>(
    ctx.chain.bulk,
    asked.map(({ bribe, token }) => bribeCall(bribe, "earned", [nft.id, token])),
    { chunk: EARNED_CHUNK, concurrency: CONCURRENCY, blockNumber: at },
  ).catch((error: unknown) => {
    log.warning("not read after the claim: what it left owing waits", {
      conduit: ctx.sender.conduit,
      tokenId: nft.id,
      error: errorMessage(error),
    });
    return asked.map(() => 0n);
  });
  const left = new Map<string, Pair>();
  asked.forEach(({ bribe, token }, i) => {
    const pair = pairKey(bribe, token);
    if (owed[i]! === 0n || nft.reopened.has(pair)) return void nft.taken.add(pair);
    nft.reopened.add(pair);
    left.set(pair, { bribe, fees: fees.includes(bribe), token, usd: valueOf(ctx, token, owed[i]!), later: 0 });
  });
  if (left.size === 0) return;
  const kept = nft.pairs.filter((p) => !left.has(pairKey(p.bribe, p.token)));
  nft.pairs = [...kept, ...left.values()];
  log.info("claimable again after the claim", {
    conduit: ctx.sender.conduit,
    tokenId: nft.id,
    usd: [...left.values()].reduce((sum, p) => sum + p.usd, 0),
  });
}

function refuse(ctx: Context, nft: Nft, { token, why, reason, usd }: Refusal): void {
  const fields = { conduit: ctx.sender.conduit, tokenId: nft.id, token, usd, reason };
  if (why === "loss") {
    nft.caps.set(token, usd / 2);
    return log.warning("swap loses too much: claiming less of it", fields);
  }
  if (why === "route") {
    nft.unswapped.add(lower(token));
    return log.warning("not swapped: no route", fields);
  }
  ctx.unswapped.add(lower(token));
  ctx.anomalies++;
  log.error("not swapped: KyberSwap answered wrongly", fields);
}

async function buildClaim(ctx: Context, nft: Nft, plan: ClaimPlan, at: bigint): Promise<Built | Refusal[]> {
  const { chain, klima, until } = ctx;
  const asked = [...plan.fees, ...plan.bribes];
  const earned = await readMany<bigint>(
    chain.bulk,
    plan.tokens.flatMap((token) => asked.map((bribe) => bribeCall(bribe, "earned", [nft.id, token]))),
    { chunk: EARNED_CHUNK, concurrency: CONCURRENCY, blockNumber: at },
  );
  let usd = 0;
  let kvcm = 0n; // the least kVCM the claim is sure to get
  const swaps: Built["swaps"] = [];
  const targets: Address[] = [];
  const data: Hex[] = [];
  const refusals: Refusal[] = [];
  for (const [t, token] of plan.tokens.entries()) {
    const amountIn = asked.reduce(
      (sum, bribe, b) => (nft.simulated.has(pairKey(bribe, token)) ? sum : sum + earned[t * asked.length + b]!),
      0n,
    );
    const sold = valueOf(ctx, token, amountIn);
    usd += sold;
    if (klima && isAddressEqual(token, klima.kvcm)) kvcm += amountIn;
    if (!klima || amountIn === 0n || isPayout(klima, token)) continue;
    const refused = (why: Refusal["why"], reason: string) => void refusals.push({ token, why, reason, usd: sold });
    const request = { tokenIn: token, tokenOut: klima.kvcm, amountIn, account: chain.conduit };
    let swap: Swap;
    try {
      swap = await ctx.swapper({ ...request, slippageBps: SLIPPAGE_BPS }, until);
    } catch (error) {
      if (error instanceof SwapRefused) refused("route", error.message);
      else if (error instanceof BadSwap) refused("answer", error.message);
      else throw error;
      continue;
    }
    const router = [conduitCall(chain, "isApprovedRouter", [swap.router])];
    const [approved] = await readMany<boolean>(chain.bulk, router, { blockNumber: at });
    const bought = valueOf(ctx, klima.kvcm, swap.minOut);
    if (!approved) refused("answer", `KyberSwap routed through ${swap.router}, which the conduit does not approve`);
    else if (bought < sold * (1 - MAX_SWAP_LOSS)) {
      refused("loss", `a swap worth $${sold.toFixed(2)} may return only $${bought.toFixed(2)}`);
    } else {
      swaps.push({ token, amountIn, quoted: swap.amountOut, minOut: swap.minOut });
      targets.push(swap.router);
      data.push(swap.data);
      kvcm += swap.minOut;
    }
  }
  if (refusals.length) return refusals;
  const { fees, bribes, tokens } = plan;
  if (!klima) return { call: { functionName: "claim", args: [nft.id, fees, bribes, tokens] }, usd, swaps };
  const maxKvcmIn = (kvcm * klima.retireBps) / 10_000n;
  const retireTonnes = maxKvcmIn > 0n ? await tonnesFor(chain, klima, (maxKvcmIn * RETIRE_PERCENT) / 100n, at) : 0n;
  const retirement = { retireTonnes, maxKvcmIn: retireTonnes ? maxKvcmIn : 0n };
  const args = [nft.id, targets, data, fees, bribes, tokens, retireTonnes, retirement.maxKvcmIn] as const;
  return { call: { functionName: "claimSwapAndDistribute", args }, usd, swaps, retirement };
}

/**
 * The price per tonne barely changes with the amount, so a few rounds of guessing get close. A guess that is still over
 * `budget` is cut back until it fits.
 */
async function tonnesFor(chain: Chain, klima: Klima, budget: bigint, at: bigint): Promise<bigint> {
  const { aggregator, creditToken, creditTokenId, kvcm, carbonClass } = klima;
  const quote = async (tonnes: bigint) => {
    const args = [creditToken, creditTokenId, tonnes, kvcm, carbonClass, 0n];
    const quoted = call(aggregator, retirementAbi, "quoteRetireCreditViaKlima", args);
    const [[, price] = []] = await readMany<readonly bigint[]>(chain.bulk, [quoted], { blockNumber: at });
    if (!price) throw new Error(`no retirement price for ${tonnes}`);
    return price;
  };
  let tonnes = (budget * TONNE) / (await quote(TONNE));
  for (let step = 0; step < 3 && tonnes > 0n; step++) tonnes = (tonnes * budget) / (await quote(tonnes));
  for (let step = 0; tonnes > 0n; step++) {
    const price = await quote(tonnes);
    if (price <= budget) return tonnes;
    if (step === 5) throw new Error(`no retirement within ${budget} kVCM: ${tonnes} cost ${price}`);
    tonnes = (tonnes * budget * 99n) / (price * 100n);
  }
  return 0n;
}

/**
 * Checks that the claim swaps everything it takes of each token, except payouts, so that nothing stays in the conduit.
 * The immutable conduit pays out everything it takes.
 */
function checkTaken({ klima, sender }: Context, logs: readonly Log[], { swaps }: Built): void {
  if (!klima) return;
  const completed = parseEventLogs({ abi: conduitAbi, logs: [...logs], eventName: "ClaimSwapAndDistributeCompleted" })
    .filter((event) => isAddressEqual(event.address, sender.conduit))
    .at(0);
  if (!completed) throw new Error("the simulated claim did not complete");
  const { claimedTokens, claimedAmounts } = completed.args;
  claimedTokens.forEach((token, i) => {
    if (isPayout(klima, token)) return;
    const swapped = swaps.find((s) => isAddressEqual(s.token, token))?.amountIn ?? 0n;
    if (claimedAmounts[i] !== swapped) {
      throw new Error(`the claim would take ${claimedAmounts[i]} of ${token} but swap ${swapped}`);
    }
  });
}

async function confirm({ chain, sender, klima }: Context, id: bigint, hash: Hex, nonce: number): Promise<bigint> {
  // A claim whose outcome is unknown stops the claims, because another claim could take what it may have taken.
  const receipt = await confirmTx(chain, sender.from, hash, nonce, "claim").catch((error: unknown) => {
    throw error instanceof Unconfirmed ? new Stop(error.message) : error;
  });
  const ours = (event: { address: Address }) => isAddressEqual(event.address, sender.conduit);
  const fields = { conduit: sender.conduit, tokenId: id, hash, block: receipt.blockNumber };
  if (!klima) {
    const claimed = parseEventLogs({ abi: immutableAbi, logs: receipt.logs, eventName: "Claimed" }).find(ours)?.args;
    // Logged with the field names of the Klima conduit's event.
    log.info("claim confirmed", {
      ...fields,
      owner: claimed?.owner,
      claimedTokens: claimed?.tokens,
      claimedAmounts: claimed?.amounts,
      treasuryFees: claimed?.fees,
    });
    return receipt.blockNumber;
  }
  const events = parseEventLogs({ abi: conduitAbi, logs: receipt.logs }).filter(ours);
  const completed = events.find((e) => e.eventName === "ClaimSwapAndDistributeCompleted")?.args;
  const retired = events.find((e) => e.eventName === "CarbonRetired")?.args;
  log.info("claim confirmed", { ...fields, ...completed, ...retired });
  return receipt.blockNumber;
}

async function readKlima(chain: Chain): Promise<Klima> {
  const names = ["kvcm", "retireBps", "retirementAggregator", "creditToken", "creditTokenId", "carbonClass"];
  const values = await readMany<unknown>(
    chain.bulk,
    names.map((name) => conduitCall(chain, name)),
  );
  const [kvcm, retireBps, aggregator, creditToken, creditTokenId, carbonClass] = values as [
    Address,
    bigint,
    Address,
    Address,
    bigint,
    Address,
  ];
  // There is no length to read, so entries are read until one reverts.
  const entries = await readEach<Address>(
    chain.bulk,
    Array.from({ length: 16 }, (_, i) => conduitCall(chain, "distributionTokens", [BigInt(i)])),
  );
  const end = entries.indexOf(undefined);
  const payouts = (end < 0 ? entries : entries.slice(0, end)) as Address[];
  if (!payouts.some((payout) => isAddressEqual(payout, kvcm))) {
    throw new Error(`kVCM is not a distribution token of the conduit: ${payouts.join(",")}`);
  }
  return { kvcm, payouts, retireBps, aggregator, creditToken, creditTokenId, carbonClass };
}

/** Indexed by veNFT id minus one. */
async function readDelegatees(chain: Chain, at: bigint): Promise<Address[]> {
  const [minted] = await readMany<bigint>(chain.bulk, [veCall(chain, "totalNftsMinted")]);
  const ids = Array.from({ length: Number(minted) }, (_, i) => BigInt(i + 1));
  return readMany<Address>(
    chain.bulk,
    ids.map((id) => veCall(chain, "delegates", [id, at])),
    { concurrency: CONCURRENCY },
  );
}

async function readDelegators(chain: Chain, conduit: Address, at: bigint, delegatees: Address[]) {
  const { bulk } = chain;
  const mine = delegatees.flatMap((delegatee, i) => (isAddressEqual(delegatee, conduit) ? [BigInt(i + 1)] : []));
  const [details, [power]] = await Promise.all([
    readEach<Address | boolean | bigint>(
      bulk,
      mine.flatMap((id) => [
        veCall(chain, "ownerOf", [id]),
        veCall(chain, "isApprovedClaimRedirectOrOwner", [conduit, id]),
        veCall(chain, "balanceOfNFTAt", [id, at]),
      ]),
    ),
    readMany<bigint>(bulk, [veCall(chain, "getPastVotes", [conduit, at])]),
  ]);
  const found = mine.reduce((sum, _, i) => sum + ((details[3 * i + 2] as bigint | undefined) ?? 0n), 0n);
  if (found !== power) log.warning("delegators found do not hold the conduit's votes", { conduit, at, found, power });
  return mine.map((id, i) => ({
    id,
    owner: details[3 * i] as Address | undefined,
    approved: details[3 * i + 1] === true,
  }));
}

/** Every fee and bribe contract, including those of pools whose gauge was killed, which still pay. */
async function readContracts(chain: Chain): Promise<Bribe[]> {
  const read: Reader = <T>(calls: Call[]) => readMany<T>(chain.bulk, calls, { concurrency: CONCURRENCY });
  const seen = new Set<string>();
  return (await readBribes(chain, read)).filter(({ bribe }) => {
    if (bribe === zeroAddress || seen.has(lower(bribe))) return false;
    seen.add(lower(bribe));
    return true;
  });
}

async function readPayingPairs(
  chain: Chain,
  conduit: Address,
  bribes: Bribe[],
  tokens: Address[],
  epochs: bigint[],
): Promise<Paying[]> {
  const read: Reader = <T>(calls: Call[]) => readMany<T>(chain.bulk, calls, { concurrency: CONCURRENCY });
  const balances = await read<bigint>(
    bribes.flatMap(({ bribe }) => epochs.map((epoch) => bribeCall(bribe, "balanceOfOwnerAt", [conduit, epoch]))),
  );
  const voted = bribes.flatMap((b, i) => {
    const on = epochs.filter((_, k) => balances[i * epochs.length + k]! > 0n);
    return on.length ? [{ ...b, on }] : [];
  });
  const kept = await readRewardTokens(read, voted, tokens);
  const data = await read<readonly bigint[]>(
    kept.flatMap(({ bribe, token, on }) => on.map((epoch) => bribeCall(bribe, "rewardData", [token, epoch]))),
  );
  let k = 0;
  return kept.flatMap(({ bribe, fees, token, on }) => {
    const paid = on.map(() => data[k++]![1]!).some((amount) => amount > 0n);
    return paid ? [{ bribe, fees, token }] : [];
  });
}

/**
 * What each veNFT is owed past the 50 epochs that earned() looks at. A claim moves that window forward, so this becomes
 * claimable right after.
 */
async function readHidden(chain: Chain, nfts: Nft[], paying: Paying[], start: bigint): Promise<Map<string, bigint>[]> {
  const read = <T>(calls: Call[]) => readMany<T>(chain.bulk, calls, { concurrency: CONCURRENCY });
  const bribes = [...new Set(paying.map(({ bribe }) => bribe))];
  const stampCalls = nfts.flatMap(({ id }) =>
    paying.map(({ bribe, token }) => bribeCall(bribe, "tokenTimestamp", [id, token])),
  );
  const [stamps, points] = await Promise.all([
    read<bigint>([...stampCalls, ...bribes.map((bribe) => bribeCall(bribe, "firstBribeTimestamp"))]),
    read<readonly [unknown, number]>(nfts.map(({ id }) => veCall(chain, "getFirstEscrowPoint", [id]))),
  ]);
  const firstOf = new Map(bribes.map((bribe, i) => [bribe, stamps[stampCalls.length + i]!]));
  const past = nfts.flatMap(({ id }, n) =>
    paying.flatMap(({ bribe, token }, j) => {
      // Where earned() starts, worked out the same way the bribe contract does.
      const first = firstOf.get(bribe)!;
      let from = stamps[n * paying.length + j]!;
      if (from < first) {
        const created = (BigInt(points[n]![1]) / WEEK) * WEEK;
        from = created > first ? created : first - WEEK;
      }
      const end = from + WINDOW * WEEK;
      const count = end < start ? (start - end) / WEEK : 0n;
      return Array.from({ length: Number(count < WINDOW ? count : WINDOW) }, (_, k) => ({
        n,
        pair: pairKey(bribe, token),
        call: bribeCall(bribe, "earnedTokenId", [id, token, end + BigInt(k) * WEEK]),
      }));
    }),
  );
  const amounts = await read<bigint>(past.map(({ call }) => call));
  const hidden = nfts.map(() => new Map<string, bigint>());
  past.forEach(({ n, pair }, i) => hidden[n]!.set(pair, (hidden[n]!.get(pair) ?? 0n) + amounts[i]!));
  return hidden;
}

function valueOf({ priced, decimals }: Context, token: Address, amount: bigint): number {
  const price = priced.get(lower(token));
  const places = decimals.get(lower(token));
  return price === undefined || places === undefined ? 0 : Number(formatUnits(amount, places)) * price;
}

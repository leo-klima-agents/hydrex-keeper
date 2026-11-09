import { encodeFunctionData, erc20Abi, parseEther, zeroAddress, type Abi, type Address } from "viem";
import { aeroQuoterAbi, aeroRouterAbi, allowanceAbi, safeAbi, uniswapQuoterAbi, uniswapRouterAbi } from "./abi.ts";
import {
  blockAtLeast,
  byConduit,
  call,
  CONDUITS,
  lower,
  otherOf,
  readEach,
  readMany,
  TRAITS,
  WETH,
  type ByConduit,
  type Call,
  type Chain,
  type Conduit,
  type ConduitName,
} from "./chain.ts";
import { errorMessage, log } from "./log.ts";
import type { Run } from "./pass.ts";
import { broadcastTx, confirmTx, heldAt, prepareTx, signTx, type TxCall } from "./vote.ts";

/** Safe's Allowance Module, version 1.0.0. */
export const ALLOWANCE_MODULE: Address = "0x691f59471Bfd2B7d639DCF74671a2d648ED1E331";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Uniswap's SwapRouter02 and QuoterV2, from Uniswap's deployment docs. The router keeps swap output sent to
// ADDRESS_THIS, so that it can unwrap it.
export const UNISWAP_ROUTER: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
const UNISWAP_QUOTER: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNISWAP_SELF: Address = "0x0000000000000000000000000000000000000002";
// Aero's Slipstream SwapRouter and Metaquoter, from Aero's security docs. The router keeps swap output sent to the zero
// address.
export const AERO_ROUTER: Address = "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418";
const AERO_QUOTER: Address = "0x1dDfeC5058180C207F55BB77D95AcDd0d8227868";
export const TARGET = parseEther("0.003");
// check.sh fails while a key holds less: MIN_KEY_WEI in sh/lib.sh.
const MIN_ETH = parseEther("0.002");
/**
 * The conduit whose treasury pays for both keys' ETH. Its key draws USDC under the treasury's allowance, swaps it to
 * ETH, and sends the other conduit's key its share.
 */
export const FUNDER: ConduitName = CONDUITS.find((name) => TRAITS[name].fundsKeys)!;
export const TOP_UP_MS = 5 * 60_000; // the scheduled run starts 10 minutes before its vote
export const MIN_SWAP = 1_000_000n; // 1 USDC
export const MIN_SEND = parseEther("0.0001");
const MAX_LOSS = 0.02; // the most a swap may lose against the job's prices
const QUOTE_MARGIN_BPS = 50n; // the swap's minimum output is this far under its quote
const DEADLINE_SLACK_MS = 60_000;

export type Venue = {
  name: string;
  router: Address;
  quote: (amountIn: bigint) => Call;
  swap: (amountIn: bigint, amountOutMinimum: bigint, to: Address, deadline: bigint) => TxCall;
};

const unwrap = (abi: Abi, amountMinimum: bigint, to: Address) =>
  encodeFunctionData({ abi, functionName: "unwrapWETH9", args: [amountMinimum, to] });

const uniswap = (fee: number): Venue => ({
  name: `Uniswap ${fee}`,
  router: UNISWAP_ROUTER,
  quote: (amountIn) =>
    call(UNISWAP_QUOTER, uniswapQuoterAbi, "quoteExactInputSingle", [
      { tokenIn: USDC, tokenOut: WETH, amountIn, fee, sqrtPriceLimitX96: 0n },
    ]),
  swap: (amountIn, amountOutMinimum, to, deadline) => {
    const params = { tokenIn: USDC, tokenOut: WETH, fee, recipient: UNISWAP_SELF, amountIn, amountOutMinimum };
    const args = [{ ...params, sqrtPriceLimitX96: 0n }] as const;
    const swap = encodeFunctionData({ abi: uniswapRouterAbi, functionName: "exactInputSingle", args });
    const data = [swap, unwrap(uniswapRouterAbi, amountOutMinimum, to)];
    return { to: UNISWAP_ROUTER, abi: uniswapRouterAbi, functionName: "multicall", args: [deadline, data] };
  },
});

const aero = (tickSpacing: number, pool: Address): Venue => ({
  name: `Aero ${tickSpacing}`,
  router: AERO_ROUTER,
  quote: (amountIn) => call(AERO_QUOTER, aeroQuoterAbi, "quoteExactInputSingleV3", [pool, USDC, amountIn, 0n]),
  swap: (amountIn, amountOutMinimum, to, deadline) => {
    const params = { tokenIn: USDC, tokenOut: WETH, tickSpacing, recipient: zeroAddress, deadline, amountIn };
    const args = [{ ...params, amountOutMinimum, sqrtPriceLimitX96: 0n }] as const;
    const swap = encodeFunctionData({ abi: aeroRouterAbi, functionName: "exactInputSingle", args });
    const data = [swap, unwrap(aeroRouterAbi, amountOutMinimum, to)];
    return { to: AERO_ROUTER, abi: aeroRouterAbi, functionName: "multicall", args: [data] };
  },
});

export const VENUES: Venue[] = [
  uniswap(500),
  aero(100, "0x2A430bEbD2082d8e05D56d64DEDE8944279bbC24"),
  aero(50, "0x4A7af46bC8aBc00048c6c7920a1488DAF568366c"),
];

const ROUTERS = [...new Set(VENUES.map((venue) => venue.router))];

/**
 * ETH is in wei and USDC in its 6-decimal units. `left` is what remains of the weekly allowance, `eth` each conduit's
 * key's ETH, and `usdc` the funder's key's USDC.
 */
type State = {
  at: bigint;
  funder: Conduit;
  funded: Conduit;
  treasury: Address;
  allowed: bigint;
  left: bigint;
  inTreasury: bigint;
  eth: ByConduit<bigint>;
  usdc: bigint;
  approved: Map<Address, bigint>;
  ethUsd: number;
  usdcUsd: number;
};

/** `gains` is the least ETH the step pays the funder's key. */
type Step = { what: string; call: TxCall; gains?: bigint };

/**
 * `send` returns once the step is in a block. `at` is the block to quote the swap on, and `balances` gives each
 * conduit's key's ETH there.
 */
type Executor = {
  send: (step: Step) => Promise<void>;
  at: () => Promise<bigint>;
  balances: () => Promise<ByConduit<bigint>>;
};

/**
 * If there isn't enough USDC for both keys to reach TARGET, they end up even, and that only warns, unless a key ends
 * with less than MIN_ETH. Each such key is an error, as check.sh reports it. Returns the number of failures.
 */
export async function topUp(run: Run, until: number): Promise<number> {
  try {
    const state = await readState(run, until);
    const exec = (run.dryRun ? simulator : sender)(run, state, until);
    await execute(run.chain, state, allot(state), until, exec);
    const eth = await exec.balances();
    log.info(run.dryRun ? "dry run: would top up to" : "topped up", { eth });
    const low = CONDUITS.filter((name) => eth[name] < MIN_ETH);
    for (const name of low) {
      const { role, from } = run.chain.conduits[name];
      log.error(`${role} ${from} holds ${(Number(eth[name]) / 1e18).toFixed(4)} ETH; fund it`);
    }
    return low.length;
  } catch (error) {
    log.error(run.dryRun ? "dry run: top-up failed" : "top-up failed", { error: errorMessage(error) });
    return 1;
  }
}

async function readState({ chain, prices }: Run, until: number): Promise<State> {
  const [funder, funded] = [chain.conduits[FUNDER], chain.conduits[otherOf(FUNDER)]];
  const at = await blockAtLeast(chain);
  const read = <T>(calls: Call[]) => readMany<T>(chain.client, calls, { blockNumber: at });
  const balance = (name: ConduitName) =>
    chain.client.getBalance({ address: chain.conduits[name].from, blockNumber: at });
  const [[treasury], priced, ...balances] = await Promise.all([
    read<Address>([call(funder.address, funder.abi, "TREASURY")]),
    prices([USDC, WETH], until),
    ...CONDUITS.map(balance),
  ]);
  const key = funder.from;
  const [enabled, allowance, inTreasury, usdc, ...approvals] = await read<boolean | readonly bigint[] | bigint>([
    call(treasury!, safeAbi, "isModuleEnabled", [ALLOWANCE_MODULE]),
    call(ALLOWANCE_MODULE, allowanceAbi, "getTokenAllowance", [treasury!, key, USDC]),
    call(USDC, erc20Abi, "balanceOf", [treasury!]),
    call(USDC, erc20Abi, "balanceOf", [key]),
    ...ROUTERS.map((router) => call(USDC, erc20Abi, "allowance", [key, router])),
  ]);
  const ethUsd = priced.get(lower(WETH));
  const usdcUsd = priced.get(lower(USDC));
  if (ethUsd === undefined || usdcUsd === undefined) throw new Error("ETH or USDC has no price");
  // getTokenAllowance returns the weekly amount first, then what was spent since the last reset.
  const [amount, spent] = allowance as readonly bigint[];
  const allowed = enabled ? amount! : 0n;
  return {
    at,
    funder,
    funded,
    treasury: treasury!,
    allowed,
    left: allowed > spent! ? allowed - spent! : 0n,
    inTreasury: inTreasury as bigint,
    eth: byConduit((name) => balances[CONDUITS.indexOf(name)]!),
    usdc: usdc as bigint,
    approved: new Map(ROUTERS.map((router, i) => [router, approvals[i] as bigint])),
    ethUsd,
    usdcUsd,
  };
}

const toWei = ({ ethUsd, usdcUsd }: State, usdc: bigint) =>
  BigInt(Math.floor((Number(usdc) * 1e12 * usdcUsd) / ethUsd));

/**
 * Enough USDC to take both keys to TARGET, counting what the funder's key holds, within the allowance and the treasury's
 * balance. The funder's key's ETH above TARGET can go to the other key, but not the other way around.
 */
function allot(state: State): bigint {
  const { funder, funded, eth, usdc, allowed, left, inTreasury, ethUsd, usdcUsd } = state;
  const [has, gets] = [eth[funder.name], eth[funded.name]];
  const short = (gets < TARGET ? TARGET - gets : 0n) + TARGET - has - toWei(state, usdc);
  const needed = short > 0n ? BigInt(Math.ceil(((Number(short) / 1e18) * ethUsd * 1e6) / usdcUsd)) : 0n;
  log.info("top-up", { treasury: state.treasury, allowanceLeft: left, inTreasury, ethUsd, eth, usdc, needed });
  const available = left < inTreasury ? left : inTreasury;
  if (needed <= available) return needed;
  const fields = { needed, allowanceLeft: left, inTreasury };
  const key = `${funder.label}'s ${funder.role}`;
  if (allowed === 0n) log.warning(`the treasury does not let ${key} draw USDC: not topping up`, fields);
  else if (inTreasury < left) log.warning("the treasury holds too little USDC to top up the keys: fund it", fields);
  else log.warning(`the allowance of ${key} limits the top-up this week`, fields);
  return available;
}

/** Enough to take the funded key to TARGET or, if both keys can't get there, to leave them even. */
export function shareOf(funded: bigint, funder: bigint): bigint {
  const even = (funded + funder) / 2n;
  const goal = even < TARGET ? even : TARGET;
  return goal > funded ? goal - funded : 0n;
}

const drawCall = ({ treasury, funder }: State, amount: bigint): TxCall => ({
  to: ALLOWANCE_MODULE,
  abi: allowanceAbi,
  functionName: "executeAllowanceTransfer",
  args: [treasury, USDC, funder.from, amount, zeroAddress, 0n, funder.from, "0x"],
});

const approveCall = (router: Address, amount: bigint): TxCall => ({
  to: USDC,
  abi: erc20Abi,
  functionName: "approve",
  args: [router, amount],
});

const minOut = (quoted: bigint) => (quoted * (10_000n - QUOTE_MARGIN_BPS)) / 10_000n;

/** A minute past `until`, so that a swap sent just before `until` isn't refused. */
const deadline = (until: number) => BigInt(Math.floor((until + DEADLINE_SLACK_MS) / 1000));

/**
 * The swap's minimum output is QUOTE_MARGIN_BPS under the best quote, but never more than MAX_LOSS under the job's
 * prices. Fails if no venue pays that much.
 */
async function bestVenue(
  chain: Chain,
  state: State,
  usdc: bigint,
  at: bigint,
  venues = VENUES,
): Promise<{ venue: Venue; minimum: bigint }> {
  const quotes = await readEach<readonly bigint[]>(
    chain.client,
    venues.map((venue) => venue.quote(usdc)),
    { blockNumber: at },
  );
  const paid = quotes.map((quote) => quote?.[0] ?? 0n);
  const best = paid.reduce((b, p, i) => (p > paid[b]! ? i : b), 0);
  const quoted = paid[best]!;
  const floor = BigInt(Math.floor(Number(toWei(state, usdc)) * (1 - MAX_LOSS)));
  if (quoted < floor) throw new Error(`a swap of ${usdc} USDC units pays at most ${quoted} wei, under ${floor}`);
  const venue = venues[best]!;
  const margin = minOut(quoted);
  const minimum = margin > floor ? margin : floor;
  log.info("top-up quote", { venue: venue.name, usdc, quoted, minimum });
  return { venue, minimum };
}

/**
 * Draws, approves the router, swaps, then sends the funded key its share. The swap is quoted before the draw, so that
 * nothing is drawn unless a venue pays enough, and again before the swap, so that its minimum follows the price.
 */
async function execute(chain: Chain, state: State, draw: bigint, until: number, exec: Executor): Promise<void> {
  const usdc = state.usdc + draw;
  if (usdc >= MIN_SWAP) {
    let { venue, minimum } = await bestVenue(chain, state, usdc, state.at);
    if (draw > 0n) await exec.send({ what: "draw", call: drawCall(state, draw) });
    if (state.approved.get(venue.router)! < usdc) {
      await exec.send({ what: "approval", call: approveCall(venue.router, usdc) });
    }
    const at = await exec.at();
    if (at !== state.at) ({ minimum } = await bestVenue(chain, state, usdc, at, [venue]));
    const call = venue.swap(usdc, minimum, state.funder.from, deadline(until));
    await exec.send({ what: "swap", call, gains: minimum });
  }
  const { funder, funded } = state;
  const eth = await exec.balances();
  const share = shareOf(eth[funded.name], eth[funder.name]);
  const call = { to: funded.from, value: share };
  if (share >= MIN_SEND) await exec.send({ what: `transfer to ${funded.label}'s ${funded.role}`, call });
}

function sender(run: Run, state: State, until: number): Executor {
  const { chain } = run;
  let pinned = state.at;
  const balance = (name: ConduitName) =>
    chain.client.getBalance({ address: chain.conduits[name].from, blockNumber: pinned });
  return {
    send: async ({ what, call }) => {
      pinned = await sendTx(run, state.funder, call, what, await blockAtLeast(chain, pinned), until);
    },
    at: async () => (pinned === state.at ? pinned : blockAtLeast(chain, pinned)),
    balances: async () => {
      const eth = await Promise.all(CONDUITS.map(balance));
      return byConduit((name) => eth[CONDUITS.indexOf(name)]!);
    },
  };
}

/**
 * Simulates each step after the ones before it, and checks it as sendTx does, against the funder's key's balance after
 * the earlier steps. Each step costs what it is expected to, and the swap pays its minimum.
 */
function simulator({ chain }: Run, state: State): Executor {
  const done: TxCall[] = [];
  const { funder, funded } = state;
  const eth = { ...state.eth };
  return {
    send: async ({ what, call, gains = 0n }) => {
      const options = { what: `the ${what}`, before: done, blockNumber: state.at };
      const prepared = await prepareTx(chain, funder, call, options);
      await payable(chain, funder, prepared, call, eth[funder.name]);
      done.push(call);
      const value = call.value ?? 0n;
      eth[funder.name] += gains - prepared.expectedCost - value;
      if (call.to === funded.from) eth[funded.name] += value;
      const { tx } = prepared;
      log.info("dry run: top-up simulated, not sent", { what, to: tx.to, value: tx.value, gas: tx.gas });
    },
    at: async () => state.at,
    balances: async () => ({ ...eth }),
  };
}

/**
 * Fails if a transaction this run sent from the funder's key may still land at its nonce, because it may be a vote and
 * a top-up must never replace one, or if `balance` can't pay for the call's gas and value.
 */
async function payable(
  chain: Chain,
  { label, role, from }: Conduit,
  { tx, cost }: { tx: { nonce: number }; cost: bigint },
  call: TxCall,
  balance: bigint,
): Promise<void> {
  if ((await heldAt(chain, from, tx.nonce)) !== false) {
    throw new Error(`a transaction of ${label}'s ${role} is pending at nonce ${tx.nonce}`);
  }
  const needed = cost + (call.value ?? 0n);
  if (balance < needed) throw new Error(`fund ${label}'s ${role}: ${from} has ${balance} wei, needs ${needed}`);
}

async function sendTx(
  { chain, signers }: Run,
  funder: Conduit,
  call: TxCall,
  what: string,
  at: bigint,
  until: number,
): Promise<bigint> {
  const { from } = funder;
  const prepared = await prepareTx(chain, funder, call, { what: `the ${what}`, blockNumber: at });
  await payable(chain, funder, prepared, call, prepared.balance);
  const { tx } = prepared;
  const { signed, ...ready } = await signTx(signers[funder.name], tx, false, from);
  if (!signed) throw new Error(`no key signs for ${funder.label}'s ${funder.role}`);
  const hash = await broadcastTx(chain, { ...ready, signed }, until);
  log.info("top-up sent", { what, hash, nonce: tx.nonce });
  const { blockNumber } = await confirmTx(chain, from, hash, tx.nonce, `the ${what}`);
  log.info("top-up confirmed", { what, hash, block: blockNumber });
  return blockNumber;
}

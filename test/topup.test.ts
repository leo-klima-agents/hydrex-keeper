import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseEther,
  parseTransaction,
  recoverTransactionAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { aeroRouterAbi, allowanceAbi, uniswapRouterAbi } from "../src/abi.ts";
import { WETH, type Chain, type Client } from "../src/chain.ts";
import type { Run } from "../src/pass.ts";
import {
  AERO_ROUTER,
  ALLOWANCE_MODULE,
  MIN_SEND,
  shareOf,
  TARGET,
  topUp,
  UNISWAP_ROUTER,
  USDC,
  VENUES,
} from "../src/topup.ts";
import { pendingVote, prepareVote, v2Sender } from "../src/vote.ts";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const [MODULE, CONDUIT, VOTER, VE, V2, TREASURY] = [addr(1), addr(2), addr(3), addr(4), addr(10), addr(11)];
const keeper = privateKeyToAccount(generatePrivateKey());
const proposer = privateKeyToAccount(generatePrivateKey());
const [KEEPER, PROPOSER] = [keeper.address, proposer.address];
const ETH_USD = 3000;
const usdc = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const eth = (ether: number) => parseEther(String(ether));
const low = (address: string) => address.toLowerCase();

const AERO_POOLS: Record<string, number> = {
  [low("0x2A430bEbD2082d8e05D56d64DEDE8944279bbC24")]: 100,
  [low("0x4A7af46bC8aBc00048c6c7920a1488DAF568366c")]: 50,
};
const VENUE_NAMES = ["Uniswap 500", "Aero 100", "Aero 50"];
assert.deepEqual(
  VENUES.map((venue) => venue.name),
  VENUE_NAMES,
);

type World = {
  eth: Record<string, bigint>;
  usdc: Record<string, bigint>;
  weth: Record<string, bigint>;
  approved: Record<string, bigint>;
  enabled: boolean;
  allowed: bigint;
  spent: bigint;
  /** Each venue's payout as a fraction of the fair price. Undefined makes its quote revert. */
  venues: (number | undefined)[];
  /** The payouts that replace `venues` once an approval is mined. */
  afterApproval?: (number | undefined)[];
  pending?: boolean;
  reverts?: string;
  lost?: string;
};

/** With the 0.003 ETH target, the keeper is 0.0016 ETH short and the proposer is 0.0025 ETH short. */
function world(more: Partial<World> = {}): World {
  return {
    eth: { [low(KEEPER)]: eth(0.0014), [low(PROPOSER)]: eth(0.0005) },
    usdc: { [low(TREASURY)]: usdc(50) },
    weth: {},
    approved: {},
    enabled: true,
    allowed: usdc(20),
    spent: 0n,
    venues: [0.995, 0.998, undefined],
    ...more,
  };
}

const clone = (w: World): World => ({
  ...w,
  eth: { ...w.eth },
  usdc: { ...w.usdc },
  weth: { ...w.weth },
  approved: { ...w.approved },
});

function wethFor(w: World, index: number, amount: bigint): bigint | undefined {
  const share = w.venues[index];
  if (share === undefined) return undefined;
  return (amount * 10n ** 12n * BigInt(Math.round(share * 1e6))) / (BigInt(ETH_USD) * 1_000_000n);
}

const add = (balances: Record<string, bigint>, who: string, amount: bigint) =>
  void (balances[low(who)] = (balances[low(who)] ?? 0n) + amount);

function take(balances: Record<string, bigint>, who: string, amount: bigint, what: string) {
  if ((balances[low(who)] ?? 0n) < amount) throw new Error(`${what}: balance too low`);
  add(balances, who, -amount);
}

function routerCall(w: World, from: Address, router: Address, args: readonly unknown[]): void {
  const uniswap = router === UNISWAP_ROUTER;
  assert.ok(uniswap || router === AERO_ROUTER, `a router: ${router}`);
  const abi = (uniswap ? uniswapRouterAbi : aeroRouterAbi) as Abi;
  const data = (uniswap ? args[1] : args[0]) as Hex[];
  const deadline = uniswap ? (args[0] as bigint) : undefined;
  assert.equal(data.length, 2, "a swap, then an unwrap");
  const swap = decodeFunctionData({ abi, data: data[0]! });
  const unwrap = decodeFunctionData({ abi, data: data[1]! });
  assert.equal(swap.functionName, "exactInputSingle");
  assert.equal(unwrap.functionName, "unwrapWETH9");
  const params = swap.args![0] as {
    tokenIn: Address;
    tokenOut: Address;
    fee?: number;
    tickSpacing?: number;
    recipient: Address;
    deadline?: bigint;
    amountIn: bigint;
    amountOutMinimum: bigint;
  };
  assert.deepEqual([params.tokenIn, params.tokenOut], [USDC, WETH]);
  assert.ok((deadline ?? params.deadline)! * 1000n > BigInt(Date.now()), "a deadline ahead");
  // The router must receive the WETH itself so that it can unwrap it. Uniswap's router reads address 2 as itself, and
  // Aero's reads the zero address that way.
  assert.equal(params.recipient, uniswap ? addr(2) : zeroAddress);
  const index = uniswap ? (params.fee === 500 ? 0 : -1) : VENUE_NAMES.indexOf(`Aero ${params.tickSpacing}`);
  assert.ok(index >= 0, "a venue the job lists");
  const allowed = w.approved[low(router)] ?? 0n;
  if (allowed < params.amountIn) throw new Error("STF: allowance");
  w.approved[low(router)] = allowed - params.amountIn;
  take(w.usdc, from, params.amountIn, "STF");
  const out = wethFor(w, index, params.amountIn)!;
  if (out < params.amountOutMinimum) throw new Error("Too little received");
  add(w.weth, router, out);
  const [amountMinimum, recipient] = unwrap.args as [bigint, Address];
  assert.equal(recipient, from, "the ETH goes to the proposer, which swaps");
  if (w.weth[low(router)]! < amountMinimum) throw new Error("IW");
  add(w.eth, recipient, w.weth[low(router)]!);
  w.weth[low(router)] = 0n;
}

/** A plain ETH transfer has the functionName "transfer". */
type Sent = { from: Address; to: Address; functionName: string; args: readonly unknown[]; value: bigint };

function apply(w: World, { from, to, functionName, args, value }: Sent): void {
  assert.equal(from, PROPOSER, "the proposer sends every transaction of a top-up");
  if (functionName === w.reverts) throw new Error(`${functionName} reverted`);
  switch (`${low(to)}.${functionName}`) {
    case `${low(ALLOWANCE_MODULE)}.executeAllowanceTransfer`: {
      const [safe, token, recipient, amount, paymentToken, payment, delegate, signature] = args as [
        Address,
        Address,
        Address,
        bigint,
        Address,
        bigint,
        Address,
        Hex,
      ];
      assert.deepEqual([safe, token, paymentToken, payment, signature], [TREASURY, USDC, zeroAddress, 0n, "0x"]);
      assert.equal(recipient, PROPOSER, "drawn to the proposer, which swaps for both");
      if (!w.enabled || delegate !== PROPOSER) throw new Error("not a delegate");
      if (w.spent + amount > w.allowed) throw new Error("newSpent <= allowance.amount");
      take(w.usdc, TREASURY, amount, "Could not execute token transfer");
      w.spent += amount;
      return add(w.usdc, recipient, amount);
    }
    case `${low(USDC)}.approve`: {
      const [spender, amount] = args as [Address, bigint];
      return void (w.approved[low(spender)] = amount);
    }
    case `${low(UNISWAP_ROUTER)}.multicall`:
    case `${low(AERO_ROUTER)}.multicall`:
      return routerCall(w, from, to, args);
    case `${low(KEEPER)}.transfer`:
      take(w.eth, from, value, "insufficient funds");
      return add(w.eth, to, value);
    case `${low(V2)}.vote`:
      return;
  }
  throw new Error(`unexpected ${functionName} on ${to}`);
}

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

const reverts = (call: Call) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], functionName: call.functionName, message: "execution reverted" }),
    { abi: [], contractAddress: call.address, functionName: call.functionName, args: call.args ?? [] },
  );

function read(w: World, c: Call): unknown {
  const { address, functionName, args = [] } = c;
  const [a, b] = args as [Address, Address];
  switch (functionName) {
    case "TREASURY":
      assert.equal(address, V2);
      return TREASURY;
    case "isModuleEnabled":
      assert.deepEqual([address, a], [TREASURY, ALLOWANCE_MODULE]);
      return w.enabled;
    case "getTokenAllowance":
      assert.deepEqual([address, a, b, args[2]], [ALLOWANCE_MODULE, TREASURY, PROPOSER, USDC]);
      return [w.allowed, w.spent, 10_080n, 29_872_800n, 1n];
    case "balanceOf":
      assert.equal(address, USDC);
      return w.usdc[low(a)] ?? 0n;
    case "allowance":
      assert.deepEqual([address, a], [USDC, PROPOSER]);
      return w.approved[low(b)] ?? 0n;
    case "quoteExactInputSingle": {
      const { tokenIn, tokenOut, amountIn, fee } = args[0] as {
        tokenIn: Address;
        tokenOut: Address;
        amountIn: bigint;
        fee: number;
      };
      assert.deepEqual([tokenIn, tokenOut, fee], [USDC, WETH, 500]);
      const out = wethFor(w, 0, amountIn);
      if (out === undefined) throw reverts(c);
      return [out, 0n, 0, 0n];
    }
    case "quoteExactInputSingleV3": {
      const [pool, tokenIn, amountIn] = args as [Address, Address, bigint];
      assert.equal(tokenIn, USDC);
      const out = wethFor(w, VENUE_NAMES.indexOf(`Aero ${AERO_POOLS[low(pool)]}`), amountIn);
      if (out === undefined) throw reverts(c);
      return [out, 0n, 0];
    }
  }
  throw new Error(`unexpected read ${functionName} on ${address}`);
}

const ABIS: Record<string, Abi> = {
  [low(ALLOWANCE_MODULE)]: allowanceAbi,
  [low(UNISWAP_ROUTER)]: uniswapRouterAbi,
  [low(AERO_ROUTER)]: aeroRouterAbi,
  [low(USDC)]: erc20Abi,
};

type Simulated = { account: Address; to: Address; functionName?: string; args?: readonly unknown[]; value?: bigint };

function fakeChain(w: World, { v2 = true } = {}) {
  const sent: Sent[] = [];
  const mined: Sent[] = [];
  const txs: ReturnType<typeof parseTransaction>[] = [];
  const inFlight = new Map<Hex, Sent>();
  const simulated: Sent[][] = [];
  let head = 100n;
  const client = {
    getBlockNumber: async () => head,
    getBlock: async () => ({ number: head, timestamp: 1_800_000_000n + head * 2n }),
    multicall: async ({ contracts, allowFailure }: { contracts: Call[]; allowFailure: boolean }) =>
      contracts.map((c) => {
        if (!allowFailure) return read(w, c);
        try {
          return { status: "success", result: read(w, c) };
        } catch (error) {
          return { status: "failure", error };
        }
      }),
    getBalance: async ({ address }: { address: Address }) => w.eth[low(address)] ?? 0n,
    simulateBlocks: async ({ blocks }: { blocks: { calls: Simulated[] }[] }) => {
      const after = clone(w);
      const batch = blocks[0]!.calls.map(({ account, to, functionName, args, value }) => ({
        from: account,
        to,
        functionName: functionName ?? "transfer",
        args: args ?? [],
        value: value ?? 0n,
      }));
      simulated.push(batch);
      const calls = batch.map((call) => {
        try {
          apply(after, call);
          return { status: "success", gasUsed: 100_000n, logs: [] };
        } catch (error) {
          return { status: "failure", error, gasUsed: 0n, logs: [] };
        }
      });
      return [{ calls }];
    },
    estimateMaxPriorityFeePerGas: async () => 1_000_000n,
    getFeeHistory: async () => ({ baseFeePerGas: [5_000_000n, 5_000_000n], gasUsedRatio: [0.2, 0.3], reward: [] }),
    // "latest" counts mined transactions, and "pending" also counts sent ones. A lost transaction stays pending.
    getTransactionCount: async ({ address, blockTag }: { address: Address; blockTag: string }) =>
      blockTag === "latest"
        ? mined.filter((s) => s.from === address).length
        : sent.filter((s) => s.from === address).length + (w.pending ? 1 : 0),
    estimateL1Fee: async () => 5_000n,
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const tx = inFlight.get(hash)!;
      if (tx.functionName === w.lost) throw new Error("timed out");
      head += 2n;
      mined.push(tx);
      let status = "success";
      try {
        apply(w, tx);
        if (tx.functionName === "approve" && w.afterApproval) w.venues = w.afterApproval;
      } catch {
        status = "reverted";
      }
      return { transactionHash: hash, status, blockNumber: head - 1n, logs: [] };
    },
  } as unknown as Client;
  const broadcast = async (signed: Hex) => {
    const parsed = parseTransaction(signed);
    const { to, data, value } = parsed;
    const from = await recoverTransactionAddress({ serializedTransaction: signed as never });
    const call =
      data && data !== "0x"
        ? decodeFunctionData({ abi: ABIS[low(to!)]!, data })
        : { functionName: "transfer", args: [] as readonly unknown[] };
    const tx = {
      from,
      to: getAddress(to!),
      functionName: call.functionName,
      args: call.args ?? [],
      value: value ?? 0n,
    };
    sent.push(tx);
    txs.push(parsed);
    inFlight.set(keccak256(signed), tx);
    return keccak256(signed);
  };
  const chain: Chain = {
    client,
    bulk: client,
    v2Client: client,
    broadcast,
    module: MODULE,
    conduit: CONDUIT,
    keeper: KEEPER,
    voter: VOTER,
    ve: VE,
    ...(v2 ? { v2: { conduit: V2, proposer: PROPOSER, priced: [USDC] } } : {}),
  };
  return { chain, sent, simulated, txs };
}

const prices = new Map<Address, number>([
  [low(USDC) as Address, 1],
  [low(WETH) as Address, ETH_USD],
]);

const runOf = (chain: Chain, dryRun = false): Run => ({
  chain,
  tokens: [],
  prices: async () => prices,
  account: keeper,
  proposer,
  dryRun,
});

const until = () => Date.now() + 600_000;

const near = (actual: bigint, expected: bigint, message: string) =>
  assert.ok(actual >= (expected * 99n) / 100n && actual <= (expected * 101n) / 100n, `${message}: ${actual}`);

const names = (sent: Sent[]) => sent.map(({ functionName }) => functionName);

const ALL = ["executeAllowanceTransfer", "approve", "multicall", "transfer"];

const drawn = (sent: Sent[]) => sent.find((s) => s.functionName === "executeAllowanceTransfer")?.args[3] as bigint;

const ethOf = (w: World, who: Address) => w.eth[low(who)] ?? 0n;

function swapOf(sent: Sent[]): { amountIn: bigint; minimum: bigint; deadline: bigint } {
  const { to, args } = sent.find((s) => s.functionName === "multicall")!;
  const uniswap = to === UNISWAP_ROUTER;
  const abi = (uniswap ? uniswapRouterAbi : aeroRouterAbi) as Abi;
  const data = (uniswap ? args[1] : args[0]) as Hex[];
  const params = decodeFunctionData({ abi, data: data[0]! }).args![0] as {
    amountIn: bigint;
    amountOutMinimum: bigint;
    deadline?: bigint;
  };
  const deadline = uniswap ? (args[0] as bigint) : params.deadline!;
  return { amountIn: params.amountIn, minimum: params.amountOutMinimum, deadline };
}

async function errorsOf(t: { mock: TestContext["mock"] }, body: () => Promise<unknown>): Promise<string[]> {
  const write = t.mock.method(process.stdout, "write", () => true);
  try {
    await body();
  } finally {
    write.mock.restore();
  }
  return write.mock.calls
    .map((call) => JSON.parse(String(call.arguments[0])) as { severity: string; error?: string })
    .flatMap((line) => (line.severity === "ERROR" && line.error ? [line.error] : []));
}

test("tops up both keys: the proposer draws what both lack, swaps it where it is paid most, and sends the keeper its share", async () => {
  const w = world();
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.deepEqual(names(sent), ALL);
  near(drawn(sent), usdc((0.0016 + 0.0025) * ETH_USD), "what both lack");
  assert.equal(sent.find((s) => s.functionName === "multicall")!.to, AERO_ROUTER, "Aero's pool pays most");
  const transfer = sent.find((s) => s.functionName === "transfer")!;
  assert.equal(transfer.to, KEEPER);
  near(transfer.value, eth(0.0016), "what the keeper lacks");
  near(ethOf(w, KEEPER), TARGET, "the keeper topped up");
  near(ethOf(w, PROPOSER), TARGET, "the proposer topped up, less the pool's price");
  assert.equal(w.usdc[low(PROPOSER)] ?? 0n, 0n, "all its USDC swapped");
});

test("the swap goes through the venue quoted most, past those whose quote fails", async () => {
  for (const [venues, router] of [
    [[0.999, 0.998, undefined], UNISWAP_ROUTER],
    [[undefined, undefined, 0.997], AERO_ROUTER],
  ] as const) {
    const w = world({ venues: [...venues] });
    const { chain, sent } = fakeChain(w);
    assert.equal(await topUp(runOf(chain), until()), 0);
    assert.equal(sent.find((s) => s.functionName === "multicall")!.to, router);
    near(ethOf(w, KEEPER), TARGET, "topped up");
  }
});

test("the swap is quoted again after the draw and the approval, so that its minimum follows the price", async () => {
  // The first quote is 99.8%, which would set the minimum at 99.3%. After the approval the venue pays only 99.1%, so
  // the swap has to be quoted again.
  const w = world({ afterApproval: [0.99, 0.991, undefined] });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.deepEqual(names(sent), ALL);
  near(ethOf(w, PROPOSER), TARGET, "topped up");
});

test("a swap's minimum is never further under the prices than the most a swap may lose, even quoted near it", async () => {
  // The quote is 98.1%, and half a percent under it is 97.6%. The 2% loss limit raises the minimum to 98%.
  const w = world({ venues: [0.981, 0.975, undefined] });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  const { amountIn, minimum } = swapOf(sent);
  const atPrices = (amountIn * 10n ** 12n) / BigInt(ETH_USD);
  assert.ok(minimum * 10_000n >= atPrices * 9_799n, `98% of the prices: ${minimum} for ${atPrices}`);
  assert.ok(minimum <= wethFor(w, 0, amountIn)!, "and no more than the quote");
});

test("the swap's deadline is a minute past the last send, so that a swap sent near it is not refused for it", async () => {
  for (const venues of [
    [0.999, 0.998, undefined],
    [0.995, 0.998, undefined],
  ]) {
    const { chain, sent } = fakeChain(world({ venues }));
    const last = until();
    assert.equal(await topUp(runOf(chain), last), 0);
    assert.ok(swapOf(sent).deadline * 1000n > BigInt(last + 59_000), `through ${sent.at(-2)!.to}`);
  }
});

test("keys at the target send nothing", async () => {
  const { chain, sent } = fakeChain(world({ eth: { [low(KEEPER)]: TARGET, [low(PROPOSER)]: TARGET } }));
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.equal(sent.length, 0);
});

test("without the immutable conduit, there is no proposer, and nothing is topped up", async () => {
  const { chain, sent } = fakeChain(world(), { v2: false });
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.equal(sent.length, 0);
});

test("when the allowance cannot pay for both, the proposer draws all it may, and both keys end even", async () => {
  const w = world({ allowed: usdc(10) });
  w.eth[low(PROPOSER)] = eth(0.0001);
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0, "not a failure");
  assert.equal(drawn(sent), usdc(10));
  assert.ok(ethOf(w, KEEPER) < TARGET);
  near(ethOf(w, KEEPER), ethOf(w, PROPOSER), "even");
});

test("the proposer's ETH beyond the target goes to the keeper before anything is drawn", async () => {
  const w = world({ eth: { [low(KEEPER)]: eth(0.0014), [low(PROPOSER)]: eth(0.01) } });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.deepEqual(names(sent), ["transfer"]);
  assert.equal(ethOf(w, KEEPER), TARGET);
});

test("the keeper's ETH beyond the target does not count for the proposer", async () => {
  const w = world({ eth: { [low(KEEPER)]: eth(0.01), [low(PROPOSER)]: eth(0.0005) } });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.deepEqual(names(sent), ["executeAllowanceTransfer", "approve", "multicall"]);
  near(drawn(sent), usdc(0.0025 * ETH_USD), "what the proposer lacks");
  near(ethOf(w, PROPOSER), TARGET, "topped up");
});

test("a treasury that holds too little fails the top-up, once the proposer drew what it holds", async () => {
  const w = world({ usdc: { [low(TREASURY)]: usdc(6) } });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 1);
  assert.equal(drawn(sent), usdc(6));
  near(ethOf(w, KEEPER), ethOf(w, PROPOSER), "both even");
});

test("a treasury that lets the proposer draw nothing tops up nothing, and does not fail", async () => {
  for (const more of [{ enabled: false }, { allowed: 0n }, { spent: usdc(20) }]) {
    const { chain, sent } = fakeChain(world(more));
    assert.equal(await topUp(runOf(chain), until()), 0);
    assert.equal(sent.length, 0, "and the proposer has no ETH to spare for the keeper");
  }
});

test("USDC the proposer holds counts, and is swapped with what it draws", async () => {
  const w = world();
  w.usdc[low(PROPOSER)] = usdc(2);
  w.approved[low(AERO_ROUTER)] = usdc(1);
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  const draw = drawn(sent);
  near(draw, usdc((0.0016 + 0.0025) * ETH_USD - 2), "what both still lack");
  assert.deepEqual(sent.find((s) => s.functionName === "approve")!.args, [AERO_ROUTER, usdc(2) + draw]);
  near(ethOf(w, KEEPER), TARGET, "topped up");
});

test("an approval of the router that swaps, and only of it, spares the proposer its approval", async () => {
  for (const [router, approves] of [
    [AERO_ROUTER, false],
    [UNISWAP_ROUTER, true],
  ] as const) {
    const w = world();
    w.approved[low(router)] = usdc(100);
    const { chain, sent } = fakeChain(w);
    assert.equal(await topUp(runOf(chain), until()), 0);
    assert.equal(names(sent).includes("approve"), approves);
  }
});

test("USDC left from an earlier attempt is swapped even when nothing more is needed", async () => {
  const w = world({ eth: { [low(KEEPER)]: TARGET, [low(PROPOSER)]: TARGET - eth(0.0005) } });
  w.usdc[low(PROPOSER)] = usdc(1.5);
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.deepEqual(names(sent), ["approve", "multicall"], "nothing drawn, nothing sent to the keeper");
  assert.equal(w.usdc[low(PROPOSER)] ?? 0n, 0n);
});

test("less than the minimum swap or transfer waits for a later week", async () => {
  const w = world({ eth: { [low(KEEPER)]: TARGET - eth(0.0001), [low(PROPOSER)]: TARGET } });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 0);
  assert.equal(sent.length, 0, "0.0001 ETH is 0.3 USDC, and the keeper's even share half that");
  assert.ok(shareOf(TARGET - eth(0.0001), TARGET) < MIN_SEND);
});

test("a swap that pays too far under the prices is not made, and nothing is drawn for it", async () => {
  const { chain, sent } = fakeChain(world({ venues: [0.97, 0.975, undefined] }));
  assert.equal(await topUp(runOf(chain), until()), 1);
  assert.equal(sent.length, 0);
});

test("everything goes through the proposer: one that cannot pay tops up neither key", async () => {
  const w = world();
  w.eth[low(PROPOSER)] = 1_000n;
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 1);
  assert.equal(sent.length, 0);
  assert.equal(ethOf(w, KEEPER), eth(0.0014));
});

test("a top-up never replaces a transaction pending at the proposer's nonce, which may be a vote", async () => {
  const { chain, sent } = fakeChain(world({ pending: true }));
  assert.equal(await topUp(runOf(chain), until()), 1);
  assert.equal(sent.length, 0);
});

test("a transaction that would revert is not sent, and the proposer's USDC waits for the next top-up", async () => {
  const w = world({ reverts: "multicall" });
  const { chain, sent } = fakeChain(w);
  assert.equal(await topUp(runOf(chain), until()), 1);
  assert.deepEqual(names(sent), ["executeAllowanceTransfer", "approve"]);
  assert.ok(w.usdc[low(PROPOSER)]! > 0n);
});

test("a top-up transaction whose outcome is unknown does not hold up the proposer's vote: it replaces it", async () => {
  const { chain, txs } = fakeChain(world({ lost: "transfer" }));
  assert.equal(await topUp(runOf(chain), until()), 1);
  assert.equal(await pendingVote(chain, v2Sender(chain)), undefined, "a transfer to the keeper is no vote");
  const lost = txs.at(-1)!;
  const vote = { pools: [addr(20)], weights: [1n] };
  const { tx } = await prepareVote(chain, proposer, vote, false, undefined, v2Sender(chain));
  assert.equal(tx.nonce, lost.nonce, "at its nonce");
  assert.ok(tx.maxFeePerGas * 4n >= lost.maxFeePerGas! * 5n, "a quarter more in fees");
  assert.ok(tx.maxPriorityFeePerGas * 4n >= lost.maxPriorityFeePerGas! * 5n, "and in tip");
});

test("a dry run simulates each transaction after those before it, and sends nothing", async () => {
  const w = world();
  const { chain, sent, simulated } = fakeChain(w);
  assert.equal(await topUp(runOf(chain, true), until()), 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(names(simulated.at(-1)!), ALL);
  assert.equal(w.spent, 0n, "nothing moved");
});

test("a dry run whose transactions would revert fails", async () => {
  const { chain, sent } = fakeChain(world({ reverts: "multicall" }));
  assert.equal(await topUp(runOf(chain, true), until()), 1);
  assert.equal(sent.length, 0);
});

test("a dry run fails as the run would, on a transaction pending at the proposer's nonce or a proposer that cannot pay", async (t) => {
  const pending = fakeChain(world({ pending: true }));
  const broke = world();
  broke.eth[low(PROPOSER)] = 1_000n;
  const cannotPay = fakeChain(broke);
  for (const [{ chain, sent }, reason] of [
    [pending, /a transaction of the proposer is pending at nonce 0/],
    [cannotPay, /fund the proposer: .* has 1000 wei/],
  ] as const) {
    let failures = 0;
    const errors = await errorsOf(t, async () => (failures = await topUp(runOf(chain, true), until())));
    assert.equal(failures, 1);
    assert.match(errors.join("; "), reason);
    assert.equal(sent.length, 0);
  }
});

test("a dry run checks each step on what the steps before it leave the proposer", async (t) => {
  // With the fake's fees, a step can cost up to 150,000 gas at 0.011 gwei and is expected to cost 100,000 gas at
  // 0.006 gwei, plus a 5,000 wei L1 fee each time. The proposer can pay for the draw and the approval, but then not for
  // the swap.
  const [most, expected] = [150_000n * 11_000_000n + 5_000n, 100_000n * 6_000_000n + 5_000n];
  const w = world({ eth: { [low(KEEPER)]: eth(0.0014), [low(PROPOSER)]: most + expected + expected / 2n } });
  const { chain } = fakeChain(w);
  const errors = await errorsOf(t, () => topUp(runOf(chain, true), until()));
  assert.deepEqual(errors, [`Error: fund the proposer: ${PROPOSER} has ${most - expected / 2n} wei, needs ${most}`]);
});

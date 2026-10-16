import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  type Address,
  type BaseError,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { conduitAbi, moduleAbi, veAbi } from "../src/abi.ts";
import type { Chain, Client } from "../src/chain.ts";
import {
  claims,
  EXCLUDED_OWNERS,
  MAX_GAS_SHARE,
  MIN_CLAIM_USD,
  planClaim,
  worthClaiming,
  type Pair,
} from "../src/claim.ts";
import { BadSwap, SwapRefused, type Swapper } from "../src/kyber.ts";
import type { Run } from "../src/pass.ts";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const [MODULE, CONDUIT, VOTER, VE] = [addr(1), addr(2), addr(3), addr(4)];
const [ROUTER, AGGREGATOR, CREDIT, CLASS] = [addr(5), addr(6), addr(7), addr(8)];
const [I1, E1, I2, E2] = [addr(15), addr(16), addr(17), addr(18)];
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KVCM: Address = "0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const HYDX: Address = "0x00000e7efa313F4E11Bfff432471eD9423AC6B30";
const AZUSD: Address = "0x3595ca37596D5895B70EFAB592ac315D5B9809B2";
const JUNK = addr(99);
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ODD = [addr(91), addr(92), addr(93), addr(94), addr(95)];
const [OWNER, SMALL, OTHER] = [addr(21), addr(22), addr(23)];
const FOUNDATION: Address = "0xa79cd47655156b299762DFE92A67980805ce5a31";
const signer = privateKeyToAccount(generatePrivateKey());

const WEEK = 604_800n;
const START = 1_792_022_400n; // the epoch that just began
const ENDED = START - WEEK;
const RETIRE_BPS = 3333n;
const KVCM_PER_TONNE = 5n;
const E18 = 10n ** 18n;
const usdc = (dollars: number) => BigInt(dollars * 1_000_000);

/**
 * veNFT 1 is delegated elsewhere. 2 is OWNER's, 3 the Klima Foundation's, and 4 SMALL's, with $1 to claim. 5 is burned,
 * and 6 has not allowed the conduit to claim for it.
 */
const owners: Record<string, Address> = { 1: OTHER, 2: OWNER, 3: FOUNDATION, 4: SMALL, 6: OTHER };
const powers: Record<string, bigint> = { 1: 7n, 2: 100n, 3: 800n, 4: 1n, 5: 99n, 6: 10n };
const unapproved = new Set(["6"]);

/** A pool's fee contract, then its other bribe contract, each with the tokens it lists. */
type Pool = [[Address, Address[]], [Address, Address[]]];

type World = {
  pools: Pool[];
  earned: Map<string, bigint>;
  /** How many epoch reads come before the minter starts the epoch. */
  lag?: number;
  /** The node stays at the block before the claims, so it still shows what they took as owed. */
  stale?: boolean;
  /** earned() reads zero for this token after the first read. */
  hide?: Address;
  ownersFail?: boolean;
  balance?: bigint;
  gas?: (swaps: number, pairs: number) => bigint;
  /** A claim takes one more unit of USDC than is earned. */
  overpays?: boolean;
  /** The price per tonne falls with the amount, and a whole tonne costs more than a claim spends. */
  falling?: boolean;
  pending?: boolean;
  /** A pair, by `key`, that a claim only half empties, as when more than 50 epochs are owed. */
  partial?: string;
  /**
   * Rewards, by `key`, that earned() does not see yet: the veNFT never claimed there, and the contract's first bribe
   * was 60 epochs ago.
   */
  hidden?: Map<string, bigint>;
};

const key = (id: unknown, bribe: Address, token: Address) => `${id}${bribe}${token}`.toLowerCase();

/**
 * veNFT 2 is owed $60 of USDC on E1, $10 of USDC and $30 of kVCM on I1, and $10 of HYDX on E2. The others are owed
 * some USDC.
 */
function world(more: Partial<World> = {}): World {
  const earned = new Map([
    [key(2, E1, USDC), usdc(60)],
    [key(2, I1, USDC), usdc(10)],
    [key(2, I1, KVCM), 1_000n * E18],
    [key(2, E2, HYDX), 400n * E18],
    [key(3, E1, USDC), usdc(900)],
    [key(4, E1, USDC), usdc(1)],
    [key(5, E1, USDC), usdc(40)],
    [key(6, E1, USDC), usdc(50)],
  ]);
  const pools: Pool[] = [
    [
      [I1, [USDC, KVCM, HYDX]],
      [E1, [USDC, JUNK]],
    ],
    [
      [I2, []],
      [E2, [HYDX, ...ODD]],
    ],
  ];
  return { pools, earned, ...more };
}

/** The default world, with 15 more pools whose two contracts each owe veNFT 2 $3 of USDC, and $8 of HYDX on I1. */
function crowded(more: Partial<World> = {}): World {
  const w = world(more);
  w.earned.set(key(2, I1, HYDX), 8n * 40n * E18);
  for (let i = 0; i < 15; i++) {
    const [fees, other] = [addr(300 + 2 * i), addr(301 + 2 * i)];
    w.pools.push([
      [fees, [USDC]],
      [other, [USDC]],
    ]);
    w.earned.set(key(2, fees, USDC), usdc(3));
    w.earned.set(key(2, other, USDC), usdc(3));
  }
  return w;
}

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

function retirementPrice(w: World, tonnes: bigint): bigint {
  if (!w.falling) return tonnes * KVCM_PER_TONNE;
  const t = tonnes < E18 ? tonnes : E18;
  return (tonnes * (20_000n * E18 - 10_000n * t)) / E18;
}

const reverts = (functionName: string) =>
  new ContractFunctionRevertedError({ abi: veAbi, functionName, message: "execution reverted" });

const failed = ({ address, functionName, args }: Call, cause: unknown) =>
  new ContractFunctionExecutionError(cause as BaseError, { abi: [], contractAddress: address, functionName, args });

function fakeChain(w: World = world()) {
  const live = new Map(w.earned);
  if (w.partial) {
    const half = live.get(w.partial)! / 2n;
    live.set(w.partial, half);
    live.set(`${w.partial}:later`, half);
  }
  const first = new Map(live);
  const listed = new Map(w.pools.flatMap(([fees, other]) => [fees, other]));
  const sent: Hex[] = [];
  const earnedFor = new Set<string>();
  let polls = 0;
  let reads = 0;
  let inFlight: readonly unknown[] = [];
  let head = 40n;
  let lastClaim = head;

  const owedAt = (block?: bigint) => ((block ?? (w.stale ? 40n : head)) >= lastClaim ? live : first);

  /** Takes what a claim takes from `owed`. It reverts if a swap sells more than the claim took. */
  function claim(owed: Map<string, bigint>, args: readonly unknown[]) {
    const [id, targets, swaps, fees, bribes, tokens] = args as [
      bigint,
      Address[],
      Hex[],
      Address[],
      Address[],
      Address[],
    ];
    const next = new Map(owed);
    const asked = [...fees, ...bribes];
    const amounts = tokens.map((token) =>
      asked.reduce((sum, bribe) => {
        const pair = key(id, bribe, token);
        const amount = next.get(pair) ?? 0n;
        next.delete(pair);
        const later = next.get(`${pair}:later`);
        if (later !== undefined) (next.set(pair, later), next.delete(`${pair}:later`));
        return sum + amount;
      }, 0n),
    );
    if (w.overpays) amounts[tokens.indexOf(USDC)]! += 1n;
    const ok = swaps.every((swap) => {
      const [token, amountIn] = decodeAbiParameters(parseAbiParameters("address, uint256"), swap);
      return amountIn <= (amounts[tokens.indexOf(token)] ?? 0n);
    });
    if (ok) {
      owed.clear();
      for (const [pair, amount] of next) owed.set(pair, amount);
    }
    const owner = owners[String(id)]!;
    const topics = encodeEventTopics({
      abi: conduitAbi,
      eventName: "ClaimSwapAndDistributeCompleted",
      args: { tokenId: id, owner, recipient: owner },
    });
    const data = encodeAbiParameters(parseAbiParameters("address[], uint256[], address[], uint256[], uint256[]"), [
      tokens,
      amounts,
      [KVCM, AZUSD],
      [1n, 0n],
      [0n, 0n],
    ]);
    const gasUsed = w.gas ? w.gas(targets.length, asked.length * tokens.length) : 8_000_000n;
    return { ok, gasUsed, logs: ok ? [{ address: CONDUIT, topics, data }] : [] };
  }

  function answerAt({ address, functionName, args = [] }: Call, owed: Map<string, bigint>): unknown {
    const [a, b] = args as [unknown, unknown];
    switch (`${address}.${functionName}`) {
      case `${VOTER}._epochTimestamp`:
        return polls++ < (w.lag ?? 0) ? START - WEEK : START;
      case `${VOTER}.lastVoted`:
        return START - 100n;
      case `${VOTER}.length`:
        return BigInt(w.pools.length);
      case `${VOTER}.pools`:
        return addr(1_000 + Number(a));
      case `${VOTER}.gauges`:
        return addr(2_000 + Number(BigInt(a as Address)) - 1_000);
      case `${VOTER}.isAlive`:
        return a !== addr(2_001); // the second pool's gauge is killed, but its contracts still pay
      case `${VOTER}.internal_bribes`:
        return w.pools[Number(BigInt(a as Address)) - 2_000]![0][0];
      case `${VOTER}.external_bribes`:
        return w.pools[Number(BigInt(a as Address)) - 2_000]![1][0];
      case `${VE}.getPastVotes`:
        return Object.entries(powers).reduce((sum, [id, power]) => (id === "1" ? sum : sum + power), 0n);
      case `${VE}.totalNftsMinted`:
        return 6n;
      case `${VE}.delegates`:
        assert.equal(b, ENDED, "the delegates when the epoch that ended began");
        return a === 1n ? OTHER : CONDUIT;
      case `${VE}.ownerOf`:
        if (!owners[String(a)]) throw reverts("ownerOf");
        return owners[String(a)];
      case `${VE}.isApprovedClaimRedirectOrOwner`:
        assert.equal(a, CONDUIT);
        return !unapproved.has(String(b));
      case `${VE}.balanceOfNFTAt`:
        return powers[String(a)];
      case `${VE}.getFirstEscrowPoint`:
        return [{ bias: 0n, slope: 0n, permanent: 0n }, Number(START - 100n * WEEK)];
      case `${CONDUIT}.kvcm`:
        return KVCM;
      case `${CONDUIT}.retireBps`:
        return RETIRE_BPS;
      case `${CONDUIT}.retirementAggregator`:
        return AGGREGATOR;
      case `${CONDUIT}.creditToken`:
        return CREDIT;
      case `${CONDUIT}.creditTokenId`:
        return 0n;
      case `${CONDUIT}.carbonClass`:
        return CLASS;
      case `${CONDUIT}.distributionTokens`:
        if (a === 0n) return KVCM;
        if (a === 1n) return AZUSD;
        throw reverts("distributionTokens");
      case `${CONDUIT}.isApprovedRouter`:
        return a === ROUTER;
      case `${AGGREGATOR}.quoteRetireCreditViaKlima`: {
        const tonnes = args[2] as bigint;
        return [tonnes, retirementPrice(w, tonnes), 0n, tonnes];
      }
    }
    switch (functionName) {
      case "decimals":
        return address === USDC ? 6 : 18;
      case "balanceOfOwnerAt":
        assert.equal(a, CONDUIT);
        return listed.has(address) && b === ENDED ? 50n : 0n;
      case "rewardsListLength":
        return BigInt(listed.get(address)!.length);
      case "rewardTokens":
        return listed.get(address)![Number(a)];
      case "rewardData":
        return [0n, b === ENDED ? 1_000n : 0n, 0n];
      case "tokenTimestamp":
        return w.hidden?.has(key(a, address, b as Address)) ? 0n : START - WEEK;
      case "firstBribeTimestamp": {
        const old = [...(w.hidden?.keys() ?? [])].some((k) => k.includes(address.toLowerCase()));
        return START - (old ? 60n : 30n) * WEEK;
      }
      case "earnedTokenId": {
        const epoch = BigInt(args[2] as bigint);
        return epoch === START - WEEK ? (w.hidden?.get(key(a, address, b as Address)) ?? 0n) : 0n;
      }
      case "earned":
        earnedFor.add(String(a));
        if (w.hide === b && reads > 1) return 0n;
        return owed.get(key(a, address, b as Address)) ?? 0n;
    }
    throw new Error(`unexpected call ${functionName} on ${address}`);
  }

  const client = {
    multicall: async ({
      contracts,
      allowFailure,
      blockNumber,
    }: {
      contracts: Call[];
      allowFailure: boolean;
      blockNumber?: bigint;
    }) => {
      if (contracts.some((c) => c.functionName === "earned")) reads++;
      const owed = owedAt(blockNumber);
      const answer = (c: Call) => answerAt(c, owed);
      if (!allowFailure) return contracts.map(answer);
      if (w.ownersFail && contracts.some((c) => c.functionName === "ownerOf")) {
        // A node error (-32603) looks like a revert of the multicall contract.
        const error = failed({ address: MULTICALL3, functionName: "aggregate3" }, reverts("aggregate3"));
        return contracts.map(() => ({ status: "failure", error }));
      }
      return contracts.map((c) => {
        try {
          return { status: "success", result: answer(c) };
        } catch (error) {
          return { status: "failure", error: failed(c, error) };
        }
      });
    },
    getGasPrice: async () => 6_000_000n,
    getBlockNumber: async () => (w.stale ? 40n : head),
    simulateBlocks: async ({
      blocks,
      blockNumber,
    }: {
      blocks: { blockOverrides?: unknown; calls: { args: unknown[] }[] }[];
      blockNumber?: bigint;
    }) => {
      assert.equal(blocks[0]!.blockOverrides, undefined, "a claim does not depend on the time");
      const owed = new Map(owedAt(blockNumber));
      const calls = blocks[0]!.calls.map(({ args }) => {
        const { ok, ...result } = claim(owed, args);
        return ok
          ? { status: "success", ...result }
          : { status: "failure", error: new Error("swap failed"), ...result };
      });
      return [{ calls }];
    },
    estimateMaxPriorityFeePerGas: async () => 1_000_000n,
    getFeeHistory: async () => ({
      baseFeePerGas: [5_000_000n, 5_000_000n, 5_000_000n],
      gasUsedRatio: [0.2, 0.3],
      reward: [[1_000_000n], [1_000_000n]],
    }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      7 + sent.length + (w.pending && blockTag === "pending" ? 1 : 0),
    getBalance: async () => w.balance ?? E18,
    estimateL1Fee: async () => 5_000n,
    waitForTransactionReceipt: async ({ hash, confirmations }: { hash: Hex; confirmations: number }) => {
      assert.equal(confirmations, 2, "a block past the claim's");
      const { ok, logs } = claim(live, inFlight);
      head += 2n;
      lastClaim = head - 1n;
      return { transactionHash: hash, status: ok ? "success" : "reverted", blockNumber: lastClaim, logs };
    },
  } as unknown as Client;
  const broadcast = async (signed: Hex) => {
    sent.push(signed);
    inFlight = decodeFunctionData({ abi: moduleAbi, data: parseTransaction(signed).data! }).args;
    return keccak256(signed);
  };
  const chain: Chain = {
    client,
    bulk: client,
    broadcast,
    module: MODULE,
    conduit: CONDUIT,
    keeper: signer.address,
    voter: VOTER,
    ve: VE,
  };
  return { chain, sent, earnedFor };
}

const prices = new Map<Address, number>([
  [USDC.toLowerCase() as Address, 1],
  [KVCM.toLowerCase() as Address, 0.03],
  [WETH.toLowerCase() as Address, 3000],
  [HYDX.toLowerCase() as Address, 0.025],
  ...ODD.map((token) => [token.toLowerCase() as Address, 1] as const),
]);

const rates: Record<string, [bigint, bigint]> = { [USDC]: [100n * 10n ** 12n, 3n], [HYDX]: [5n, 6n] };

type Swaps = {
  refuse?: Address[] | ((token: Address, amountIn: bigint) => boolean);
  bad?: Address;
  lossy?: (token: Address, amountIn: bigint) => boolean;
};

/** Swaps at `prices`, minus slippage. `refuse` has no route, `bad` gets a wrong answer, and `lossy` returns half. */
function fakeSwapper({ refuse = [], bad, lossy }: Swaps = {}) {
  const asked: Address[] = [];
  const swapper: Swapper = async ({ tokenIn, tokenOut, amountIn, account, slippageBps }) => {
    assert.equal(tokenOut, KVCM);
    assert.equal(account, CONDUIT, "the conduit sells and buys");
    asked.push(tokenIn);
    if (typeof refuse === "function" ? refuse(tokenIn, amountIn) : refuse.includes(tokenIn)) {
      throw new SwapRefused("KyberSwap: route not found");
    }
    if (tokenIn === bad) throw new BadSwap("KyberSwap built another swap");
    const [num, den] = rates[tokenIn]!;
    const amountOut = (amountIn * num) / den / (lossy?.(tokenIn, amountIn) ? 2n : 1n);
    const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const data = encodeAbiParameters(parseAbiParameters("address, uint256"), [tokenIn, amountIn]);
    return { router: ROUTER, data, amountIn, amountOut, minOut };
  };
  return { swapper, asked };
}

function runOf(chain: Chain, { dryRun = false, account = signer as LocalAccount } = {}): Run {
  const tokens = [USDC, KVCM, WETH, HYDX, ...ODD].map((token) => ({ token, name: token.slice(0, 6) }));
  return { chain, tokens, prices: async () => prices, account, dryRun };
}

const decode = (signed: Hex) => {
  const { args, functionName } = decodeFunctionData({ abi: moduleAbi, data: parseTransaction(signed).data! });
  assert.equal(functionName, "claimSwapAndDistribute");
  const [id, targets, , fees, bribes, tokens, tonnes, maxKvcmIn] = args as readonly [
    bigint,
    Address[],
    Hex[],
    Address[],
    Address[],
    Address[],
    bigint,
    bigint,
  ];
  return { id, targets, fees, bribes, tokens, tonnes, maxKvcmIn };
};

const until = () => Date.now() + 600_000;

test("claims each delegator's most valuable rewards, swapped to kVCM, and retires its share of the kVCM", async () => {
  const { chain, sent, earnedFor } = fakeChain();
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  assert.equal(sent.length, 1, "veNFT 2 only");
  const claim = decode(sent[0]!);
  assert.equal(claim.id, 2n);
  assert.deepEqual(claim.tokens, [USDC, KVCM, HYDX], "the tokens that pay most, kVCM paid out as it is");
  assert.deepEqual([claim.fees, claim.bribes], [[I1], [E1, E2]]);
  assert.deepEqual(claim.targets, [ROUTER, ROUTER], "USDC and HYDX are swapped");
  const minUsdc = (((usdc(70) * 100n * 10n ** 12n) / 3n) * 9_500n) / 10_000n;
  const minHydx = (((400n * E18 * 5n) / 6n) * 9_500n) / 10_000n;
  const maxKvcmIn = ((1_000n * E18 + minUsdc + minHydx) * RETIRE_BPS) / 10_000n;
  assert.equal(claim.maxKvcmIn, maxKvcmIn);
  assert.equal(claim.tonnes, (maxKvcmIn * 97n) / 100n / KVCM_PER_TONNE, "tonnes that cost 97% of maxKvcmIn");
  assert.equal(parseTransaction(sent[0]!).nonce, 7);
  assert.deepEqual([...earnedFor].sort(), ["2", "4"], "3 is the Foundation's, 5 is burned, 6 is not approved");
});

test("the Klima Foundation's veNFTs are excluded", () => {
  assert.equal(EXCLUDED_OWNERS.get(FOUNDATION.toLowerCase()), "Klima Foundation");
});

test("a token without a route is left out of the veNFT's claims; one whose swap loses too much, capped", async () => {
  for (const swaps of [{ refuse: [HYDX] }, { lossy: (token: Address) => token === HYDX }] satisfies Swaps[]) {
    const { chain, sent } = fakeChain();
    const { swapper, asked } = fakeSwapper(swaps);
    assert.equal(await claims(runOf(chain), START, until(), swapper), 0);
    assert.equal(sent.length, 1);
    const claim = decode(sent[0]!);
    assert.deepEqual([claim.tokens, claim.fees, claim.bribes], [[USDC, KVCM], [I1], [E1]]);
    assert.deepEqual(asked, [USDC, HYDX, USDC], "HYDX is not asked for again, alone or with less of it");
  }
});

test("a swap too large to make without losing too much is claimed from fewer contracts", async () => {
  const { chain, sent } = fakeChain();
  const lossy = (token: Address, amountIn: bigint) => token === USDC && amountIn > usdc(50);
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper({ lossy }).swapper), 0);
  assert.equal(sent.length, 1, "E1's $60 of USDC is too much to swap at once");
  const claim = decode(sent[0]!);
  assert.deepEqual([claim.tokens, claim.fees, claim.bribes], [[USDC, KVCM, HYDX], [I1], [E2]]);
});

test("tokens KyberSwap cannot route do not use up a claim's plans, and are asked for once", async () => {
  const w = world();
  for (const token of ODD) w.earned.set(key(2, E2, token), 6n * E18);
  const { chain, sent } = fakeChain(w);
  const { swapper, asked } = fakeSwapper({ refuse: ODD });
  assert.equal(await claims(runOf(chain), START, until(), swapper), 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(decode(sent[0]!).tokens, [USDC, KVCM, HYDX]);
  for (const token of ODD) assert.equal(asked.filter((t) => t === token).length, 1);
});

test("a token KyberSwap has no route for at one veNFT's amount is still swapped for another's", async () => {
  const w = world();
  w.earned.set(key(4, E2, HYDX), 300n * E18); // $7.50, while veNFT 2 has 400
  const { chain, sent } = fakeChain(w);
  const { swapper } = fakeSwapper({ refuse: (token, amountIn) => token === HYDX && amountIn > 350n * E18 });
  assert.equal(await claims(runOf(chain), START, until(), swapper), 0);
  const [two, four] = sent.map(decode);
  assert.deepEqual([two!.id, two!.tokens], [2n, [USDC, KVCM]]);
  assert.deepEqual([four!.id, four!.tokens], [4n, [HYDX, USDC]]);
});

test("a wrong answer from KyberSwap leaves its token out, and fails the execution", async () => {
  const { chain, sent } = fakeChain();
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper({ bad: HYDX }).swapper), 1);
  assert.equal(sent.length, 1, "the rest is claimed");
  assert.deepEqual(decode(sent[0]!).tokens, [USDC, KVCM]);
});

test("a later claim does not count what an earlier one took, whatever a node behind it says", async () => {
  const { chain, sent } = fakeChain(crowded({ stale: true }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  assert.equal(sent.length, 2);
  const [first, second] = sent.map(decode);
  assert.deepEqual(first!.tokens, [USDC]);
  assert.ok(first!.fees.includes(I1), "the first takes I1's USDC");
  assert.ok(second!.fees.includes(I1) && second!.tokens.includes(USDC), "the second asks I1 for USDC again");
});

test("a contract still owing after a claim, as for more than 50 epochs, is claimed again in full", async () => {
  const { chain, sent } = fakeChain(crowded({ partial: key(2, I1, USDC) }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  assert.equal(sent.length, 2);
  const [first, second] = sent.map(decode);
  assert.ok(first!.fees.includes(I1) && second!.fees.includes(I1) && second!.tokens.includes(USDC));
});

test("a claim never replaces a transaction pending at its nonce, which may be a vote: the claims stop", async () => {
  const { chain, sent } = fakeChain(world({ pending: true }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
});

test("a dry run simulates each claim after those it prepared, and signs them without sending", async () => {
  const { chain, sent } = fakeChain(crowded());
  let signatures = 0;
  const account = { ...signer, signTransaction: (tx) => (signatures++, signer.signTransaction(tx)) } as LocalAccount;
  assert.equal(await claims(runOf(chain, { dryRun: true, account }), START, until(), fakeSwapper().swapper), 0);
  assert.equal(signatures, 2);
  assert.equal(sent.length, 0);
});

test("a veNFT is claimed for as long as what it has left is worth a claim", async () => {
  // 60 more pools whose two contracts each owe veNFT 2 $1 of USDC. A claim of USDC alone fits 26 contracts at most.
  const w = world();
  for (let i = 0; i < 60; i++) {
    const [fees, other] = [addr(300 + 2 * i), addr(301 + 2 * i)];
    w.pools.push([
      [fees, [USDC]],
      [other, [USDC]],
    ]);
    w.earned.set(key(2, fees, USDC), usdc(1));
    w.earned.set(key(2, other, USDC), usdc(1));
  }
  const { chain, sent } = fakeChain(w);
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  const claimed = sent.map(decode);
  assert.equal(claimed.length, 6, "$114 from 7 contracts, then $26 four times and $12 from the 116 left");
  const asked = claimed.flatMap(({ fees, bribes }) => [...fees, ...bribes]);
  assert.equal(new Set(asked).size, 3 + 120, "every contract that owes veNFT 2, once");
  assert.equal(asked.length, 3 + 120);
});

test("a claim too large for a transaction is planned again, smaller than it was", async () => {
  // Each contract and token uses 1.07M gas instead of the 0.3M planned: the first claim, planned at 5.6M, uses 12.5M.
  const gas = (swaps: number, pairs: number) => 1_300_000n + 800_000n * BigInt(swaps) + 1_066_667n * BigInt(pairs);
  const { chain, sent } = fakeChain(world({ gas }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  const [first, second] = sent.map(decode);
  assert.deepEqual([first!.tokens, first!.fees, first!.bribes], [[USDC, KVCM], [I1], [E1]]);
  assert.deepEqual([second!.tokens, second!.bribes], [[HYDX], [E2]], "what is left, in a second claim");
  const never = fakeChain(world({ gas: () => 20_000_000n }));
  assert.equal(await claims(runOf(never.chain), START, until(), fakeSwapper().swapper), 1);
  assert.equal(never.sent.length, 0);
});

test("the tonnes retired cost at most their budget, even when the price per tonne falls with the tonnes", async () => {
  const w = world({ falling: true });
  const { chain, sent } = fakeChain(w);
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  const { tonnes, maxKvcmIn } = decode(sent[0]!);
  assert.ok(tonnes > 0n && tonnes < E18, "less than a tonne");
  assert.ok(retirementPrice(w, tonnes) <= (maxKvcmIn * 97n) / 100n, "within 97% of maxKvcmIn");
});

test("a claim that refusals leave empty after a smaller plan is too little, not too large", async () => {
  // The first plan uses just over 12M gas. Then KyberSwap refuses USDC, the only token.
  const earned = new Map([
    [key(2, E1, USDC), usdc(60)],
    [key(2, I1, USDC), usdc(10)],
  ]);
  const gas = (swaps: number, pairs: number) => (pairs > 1 ? 12_100_000n : 5_000_000n);
  const { chain, sent } = fakeChain(world({ earned, gas }));
  let asks = 0;
  const { swapper } = fakeSwapper({ refuse: (token) => token === USDC && ++asks > 1 });
  assert.equal(await claims(runOf(chain), START, until(), swapper), 0);
  assert.equal(sent.length, 0);
});

test("a claim also asks for rewards past the 50 epochs earned() reads, to make them claimable", async () => {
  const hidden = new Map([[key(2, E2, ODD[0]!), 8n * E18]]);
  const { chain, sent } = fakeChain(world({ hidden }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  const claim = decode(sent[0]!);
  assert.ok(claim.bribes.includes(E2) && claim.tokens.includes(ODD[0]!), "E2 asked for its hidden token");
});

test("a veNFT whose rewards are past the 50 epochs earned() reads gets the claim that makes them claimable", async () => {
  // veNFT 4 has $1 of USDC to claim, and $8 that earned() does not see yet.
  const hidden = new Map([[key(4, E2, ODD[0]!), 8n * E18]]);
  const { chain, sent } = fakeChain(world({ hidden }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 0);
  const claim = sent.map(decode).find(({ id }) => id === 4n);
  assert.ok(claim, "veNFT 4 is claimed for");
  assert.ok(claim.bribes.includes(E2) && claim.tokens.includes(ODD[0]!));
});

test("a claim that would leave some of a token in the conduit is not sent, whether it swaps it or not", async () => {
  for (const w of [world({ overpays: true }), world({ hide: HYDX })]) {
    const { chain, sent } = fakeChain(w);
    assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1);
    assert.equal(sent.length, 0);
  }
});

test("a claim must leave the keeper enough for the next votes", async () => {
  const { chain, sent } = fakeChain(world({ balance: 10n ** 15n }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
});

test("a node that fails to read the owners fails the claims: its veNFTs are not taken for burned", async () => {
  const { chain, sent } = fakeChain(world({ ownersFail: true }));
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
});

async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let done = false;
  const settled = promise.finally(() => (done = true));
  for (let i = 0; i < 10_000 && !done; i++) {
    t.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done, "settled");
  return settled;
}

test("claims wait for the minter to start the epoch, and fail if it does not in time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Number(START) * 1000 + 10_000 });
  const waiting = fakeChain(world({ lag: 2 }));
  assert.equal(await drive(t, claims(runOf(waiting.chain), START, until(), fakeSwapper().swapper)), 0);
  assert.equal(waiting.sent.length, 1, "claimed once the minter started the epoch");
  const late = fakeChain(world({ lag: Infinity }));
  assert.equal(await drive(t, claims(runOf(late.chain), START, Date.now() + 60_000, fakeSwapper().swapper)), 1);
  assert.equal(late.sent.length, 0);
});

test("no claim starts in the last minute of the claims, and claims left then fail the execution", async () => {
  const { chain, sent } = fakeChain();
  assert.equal(await claims(runOf(chain), START, Date.now() + 30_000, fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
  const little = fakeChain(world({ earned: new Map([[key(2, E1, USDC), usdc(4)]]) }));
  const done = await claims(runOf(little.chain), START, Date.now() + 30_000, fakeSwapper().swapper);
  assert.equal(done, 0, "nothing left worth a claim");
});

const pair = (bribe: Address, token: Address, usd: number, fees = false): Pair => ({ bribe, fees, token, usd });

const swapped = (token: Address) => token !== KVCM;

test("a plan asks the bribe contracts that pay most for the tokens that pay most, as many as the gas allows", () => {
  const pairs = [pair(E1, USDC, 60), pair(I1, USDC, 10, true), pair(I1, KVCM, 30, true), pair(E2, HYDX, 10)];
  const plan = planClaim(pairs, 10_000_000n, 0, swapped)!;
  assert.deepEqual([plan.tokens, plan.fees, plan.bribes, plan.usd], [[USDC, KVCM, HYDX], [I1], [E1, E2], 110]);
  // 1.3M, plus 0.8M per swap, plus 0.3M per contract and token
  assert.equal(plan.gas, 1_300_000n + 2n * 800_000n + 3n * 900_000n);
  const tight = planClaim(pairs, 3_000_000n, 0, swapped)!;
  assert.deepEqual([tight.tokens, tight.bribes, tight.fees], [[USDC], [E1], [I1]], "one token, two contracts fit");
  assert.equal(planClaim(pairs, 2_000_000n, 0, swapped), undefined, "nothing fits");
  assert.equal(planClaim([], 10_000_000n, 0, swapped), undefined);
  const capped = planClaim(pairs, 10_000_000n, 0, swapped, new Map([[USDC, 35]]))!;
  assert.deepEqual([capped.fees, capped.bribes, capped.usd], [[I1], [E2], 50], "E1 owes more USDC than the cap");
});

test("a contract that owes more of a capped token than its cap is still claimed for its other tokens", () => {
  const pairs = [pair(E1, HYDX, 1000), pair(E1, USDC, 50), pair(E2, USDC, 20)];
  const plan = planClaim(pairs, 10_000_000n, 0, swapped, new Map([[HYDX, 500]]))!;
  assert.deepEqual([plan.tokens, plan.bribes, plan.usd], [[USDC], [E1, E2], 70]);
});

test("a cap counts what a claim swaps, not what it makes claimable past the 50 epochs earned() reads", () => {
  const pairs = [{ ...pair(E1, HYDX, 400), later: 300 }, pair(E2, HYDX, 200)];
  const plan = planClaim(pairs, 10_000_000n, 0, swapped, new Map([[HYDX, 500]]))!;
  assert.deepEqual([plan.tokens, plan.bribes, plan.usd], [[HYDX], [E1], 700], "E1 swaps $400, under the cap");
});

test("a bribe contract that does not pay for its gas is left out", () => {
  const usdPerGas = 1e-8; // 300k gas costs $0.003, so a contract must pay at least $0.06
  const plan = planClaim([pair(E1, USDC, 0.07), pair(E2, USDC, 0.05)], 10_000_000n, usdPerGas, swapped)!;
  assert.deepEqual(plan.bribes, [E1]);
});

test("a claim is sent if it collects at least the minimum and its gas costs at most a share of it", () => {
  assert.equal(worthClaiming(MIN_CLAIM_USD, 0), true);
  assert.equal(worthClaiming(MIN_CLAIM_USD - 0.01, 0), false);
  assert.equal(worthClaiming(100, 100 * MAX_GAS_SHARE), true);
  assert.equal(worthClaiming(100, 100 * MAX_GAS_SHARE + 0.01), false);
});

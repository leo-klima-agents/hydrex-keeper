import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { conduitAbi, moduleAbi } from "../src/abi.ts";
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
import { SwapRefused, type Swapper } from "../src/kyber.ts";
import type { Run } from "../src/pass.ts";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const [MODULE, CONDUIT, VOTER, VE] = [addr(1), addr(2), addr(3), addr(4)];
const [ROUTER, AGGREGATOR, CREDIT, CLASS] = [addr(5), addr(6), addr(7), addr(8)];
const [P1, P2, G1, G2] = [addr(11), addr(12), addr(13), addr(14)];
const [I1, E1, I2, E2] = [addr(15), addr(16), addr(17), addr(18)];
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KVCM: Address = "0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const HYDX: Address = "0x00000e7efa313F4E11Bfff432471eD9423AC6B30";
const AZUSD: Address = "0x3595ca37596D5895B70EFAB592ac315D5B9809B2";
const JUNK = addr(99);
const [OWNER, SMALL, OTHER] = [addr(21), addr(22), addr(23)];
const FOUNDATION = "0xa79cd47655156b299762DFE92A67980805ce5a31" as Address;
const signer = privateKeyToAccount(generatePrivateKey());

const START = 1_792_022_400n; // the epoch that just began
const ENDED = START - 604_800n;
const RETIRE_BPS = 3333n;
const KVCM_PER_TONNE = 5n;
const E18 = 10n ** 18n;

/** veNFT 2 is OWNER's, 3 the Klima Foundation's, 4 SMALL's and worth a dollar, 5 burned; 1 delegates elsewhere. */
const powers: Record<string, bigint> = { 1: 0n, 2: 100n, 3: 800n, 4: 1n, 5: 99n };
const owners: Record<string, Address> = { 1: OTHER, 2: OWNER, 3: FOUNDATION, 4: SMALL };
const voted = new Set([E1, I1, E2]); // on ENDED
const rewardTokens: Record<string, Address[]> = { [E1]: [USDC, JUNK], [I1]: [USDC, KVCM], [E2]: [HYDX], [I2]: [] };
const paid = new Set([E1 + USDC, I1 + USDC, I1 + KVCM, E2 + HYDX]); // on ENDED

/** What each veNFT has earned, by bribe contract and token: $60, $10 and $30 of kVCM, $10 of HYDX for veNFT 2. */
const earnings = () =>
  new Map<string, bigint>([
    [`2${E1}${USDC}`, 60_000_000n],
    [`2${I1}${USDC}`, 10_000_000n],
    [`2${I1}${KVCM}`, 1_000n * E18],
    [`2${E2}${HYDX}`, 400n * E18],
    [`3${E1}${USDC}`, 900_000_000n],
    [`4${E1}${USDC}`, 1_000_000n],
  ]);

type Behaviour = {
  balance?: bigint;
  gasUsed?: bigint;
  /** Claims one more unit of USDC than is earned, as if the bribe contract paid more than it said. */
  overpays?: boolean;
};

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

/** A chain that answers the claim pass's reads and records what it is asked to send. */
function fakeChain(b: Behaviour = {}) {
  const earned = earnings();
  const sent: Hex[] = [];
  const earnedFor = new Set<string>();
  const logsFor = (args: readonly unknown[]) => {
    const [id, , , fees, bribes, tokens] = args as [bigint, Address[], Hex[], Address[], Address[], Address[]];
    const amounts = tokens.map((token) =>
      [...fees, ...bribes].reduce((sum, bribe) => sum + (earned.get(`${id}${bribe}${token}`) ?? 0n), 0n),
    );
    if (b.overpays) amounts[tokens.indexOf(USDC)]! += 1n;
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
    return [{ address: CONDUIT, topics, data }];
  };
  let lastClaim: readonly unknown[] = [];

  function answer({ address, functionName, args = [] }: Call): unknown {
    const [a, b2] = args as [unknown, unknown];
    switch (`${address}.${functionName}`) {
      case `${VOTER}._epochTimestamp`:
        return START;
      case `${VOTER}.lastVoted`:
        return START - 100n;
      case `${VOTER}.length`:
        return 2n;
      case `${VOTER}.pools`:
        return [P1, P2][Number(a)];
      case `${VOTER}.gauges`:
        return { [P1]: G1, [P2]: G2 }[a as string];
      case `${VOTER}.internal_bribes`:
        return { [G1]: I1, [G2]: I2 }[a as string];
      case `${VOTER}.external_bribes`:
        return { [G1]: E1, [G2]: E2 }[a as string];
      case `${VE}.getPastVotes`:
        return 1_000n;
      case `${VE}.totalNftsMinted`:
        return 5n;
      case `${VE}.delegates`:
        assert.equal(b2, ENDED, "the delegates when the epoch that ended began");
        return a === 1n ? OTHER : CONDUIT;
      case `${VE}.ownerOf`:
        if (!owners[String(a)]) throw new Error("ERC721NonexistentToken");
        return owners[String(a)];
      case `${VE}.isApprovedClaimRedirectOrOwner`:
        assert.equal(a, CONDUIT);
        return true;
      case `${VE}.balanceOfNFTAt`:
        return powers[String(a)];
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
        throw new Error("revert");
      case `${CONDUIT}.isApprovedRouter`:
        return a === ROUTER;
      case `${AGGREGATOR}.quoteRetireCreditViaKlima`: {
        const tonnes = args[2] as bigint;
        return [tonnes, tonnes * KVCM_PER_TONNE, 0n, tonnes];
      }
    }
    switch (functionName) {
      case "decimals":
        return address === USDC ? 6 : 18;
      case "balanceOfOwnerAt":
        assert.equal(a, CONDUIT);
        return voted.has(address) && b2 === ENDED ? 50n : 0n;
      case "rewardsListLength":
        return BigInt(rewardTokens[address]!.length);
      case "rewardTokens":
        return rewardTokens[address]![Number(a)];
      case "rewardData":
        return [0n, paid.has(address + (a as string)) && b2 === ENDED ? 1_000n : 0n, 0n];
      case "earned":
        earnedFor.add(String(a));
        return earned.get(`${a}${address}${b2}`) ?? 0n;
    }
    throw new Error(`unexpected call ${functionName} on ${address}`);
  }

  const client = {
    multicall: async ({ contracts, allowFailure }: { contracts: Call[]; allowFailure: boolean }) =>
      allowFailure
        ? contracts.map((c) => {
            try {
              return { status: "success", result: answer(c) };
            } catch (error) {
              return { status: "failure", error };
            }
          })
        : contracts.map(answer),
    getGasPrice: async () => 6_000_000n,
    simulateBlocks: async ({ blocks }: { blocks: { blockOverrides?: unknown; calls: { args: unknown[] }[] }[] }) => {
      assert.equal(blocks[0]!.blockOverrides, undefined, "a claim is simulated in the node's next block");
      lastClaim = blocks[0]!.calls[0]!.args;
      return [{ calls: [{ status: "success", gasUsed: b.gasUsed ?? 8_000_000n, logs: logsFor(lastClaim) }] }];
    },
    estimateMaxPriorityFeePerGas: async () => 1_000_000n,
    getFeeHistory: async () => ({
      baseFeePerGas: [5_000_000n, 5_000_000n, 5_000_000n],
      gasUsedRatio: [0.2, 0.3],
      reward: [[1_000_000n], [1_000_000n]],
    }),
    getTransactionCount: async () => 7 + sent.length,
    getBalance: async () => b.balance ?? E18,
    estimateL1Fee: async () => 5_000n,
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const logs = logsFor(lastClaim);
      // What the claim took is no longer owed.
      const [id, , , fees, bribes, tokens] = lastClaim as [bigint, Address[], Hex[], Address[], Address[], Address[]];
      for (const bribe of [...fees, ...bribes]) for (const token of tokens) earned.delete(`${id}${bribe}${token}`);
      return { transactionHash: hash, status: "success", blockNumber: 42n, logs };
    },
  } as unknown as Client;
  const broadcast = async (signed: Hex) => {
    sent.push(signed);
    return keccak256(signed);
  };
  const chain: Chain = {
    client,
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
]);

/** kVCM per unit of each token, at `prices`. */
const rates: Record<string, [bigint, bigint]> = { [USDC]: [100n * 10n ** 12n, 3n], [HYDX]: [5n, 6n] };

/** Quotes at `prices`, minus the slippage; `refuse` has no route, and `lose` returns half its value. */
function fakeSwapper({ refuse, lose }: { refuse?: Address; lose?: Address } = {}) {
  const asked: Address[] = [];
  const swapper: Swapper = async ({ tokenIn, tokenOut, amountIn, account, slippageBps }) => {
    assert.equal(tokenOut, KVCM);
    assert.equal(account, CONDUIT, "the conduit sells and buys");
    asked.push(tokenIn);
    if (tokenIn === refuse) throw new SwapRefused("KyberSwap: route not found");
    const [num, den] = rates[tokenIn]!;
    const amountOut = (amountIn * num) / den / (tokenIn === lose ? 2n : 1n);
    const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return { router: ROUTER, data: `0x1234${tokenIn.slice(2, 6)}`, amountIn, amountOut, minOut };
  };
  return { swapper, asked };
}

function runOf(chain: Chain, dryRun = false): Run {
  const tokens = [USDC, KVCM, WETH, HYDX].map((token) => ({ token, name: token.slice(0, 6) }));
  return { chain, tokens, prices: async () => prices, account: signer, dryRun };
}

const decode = (signed: Hex) => {
  const { args, functionName } = decodeFunctionData({ abi: moduleAbi, data: parseTransaction(signed).data! });
  assert.equal(functionName, "claimSwapAndDistribute");
  const [id, targets, swaps, fees, bribes, tokens, tonnes, maxKvcmIn] = args as [
    bigint,
    Address[],
    Hex[],
    Address[],
    Address[],
    Address[],
    bigint,
    bigint,
  ];
  return { id, targets, swaps, fees, bribes, tokens, tonnes, maxKvcmIn };
};

const until = () => Date.now() + 60_000;

test("claims each delegator's most valuable rewards, swapped to kVCM, and retires its share of the kVCM", async () => {
  const { chain, sent, earnedFor } = fakeChain();
  const { swapper } = fakeSwapper();
  assert.equal(await claims(runOf(chain), START, until(), swapper), 0);
  assert.equal(sent.length, 1, "veNFT 2 only: 3 is the Foundation's, 4 earned a dollar, 5 is burned");
  const claim = decode(sent[0]!);
  assert.equal(claim.id, 2n);
  assert.deepEqual(claim.tokens, [USDC, KVCM, HYDX], "the tokens that pay most, kVCM paid out as it is");
  assert.deepEqual([claim.fees, claim.bribes], [[I1], [E1, E2]]);
  assert.deepEqual(claim.targets, [ROUTER, ROUTER], "USDC and HYDX are swapped");
  // The kVCM the claim is sure to get: 1,000 claimed, and the swaps' minimum returns at 5% slippage.
  const minUsdc = (((70_000_000n * 100n * 10n ** 12n) / 3n) * 9_500n) / 10_000n;
  const minHydx = (((400n * E18 * 5n) / 6n) * 9_500n) / 10_000n;
  const maxKvcmIn = ((1_000n * E18 + minUsdc + minHydx) * RETIRE_BPS) / 10_000n;
  assert.equal(claim.maxKvcmIn, maxKvcmIn);
  assert.equal(claim.tonnes, (maxKvcmIn * 97n) / 100n / KVCM_PER_TONNE, "tonnes that cost 97% of maxKvcmIn");
  assert.ok(!earnedFor.has("3"), "the Foundation's veNFT is not even read");
  assert.equal(parseTransaction(sent[0]!).nonce, 7);
});

test("the Klima Foundation's veNFTs are excluded", () => {
  assert.equal(EXCLUDED_OWNERS.get(FOUNDATION.toLowerCase()), "Klima Foundation");
});

test("a token without a route, or whose swap would lose too much, is left out and the claim planned again", async () => {
  for (const options of [{ refuse: HYDX }, { lose: HYDX }]) {
    const { chain, sent } = fakeChain();
    const { swapper, asked } = fakeSwapper(options);
    assert.equal(await claims(runOf(chain), START, until(), swapper), 0);
    assert.equal(sent.length, 1);
    const claim = decode(sent[0]!);
    assert.deepEqual([claim.tokens, claim.fees, claim.bribes], [[USDC, KVCM], [I1], [E1]]);
    assert.deepEqual(claim.targets, [ROUTER]);
    assert.deepEqual(asked, [USDC, HYDX, USDC, HYDX], "HYDX is tried again for what is left, then given up");
  }
});

test("a claim that would leave some of a token in the conduit is not sent", async () => {
  const { chain, sent } = fakeChain({ overpays: true });
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
});

test("a claim must leave the keeper enough for the next votes", async () => {
  const { chain, sent } = fakeChain({ balance: 10n ** 15n });
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
});

test("a dry run signs claims but never sends them", async () => {
  const { chain, sent } = fakeChain();
  assert.equal(await claims(runOf(chain, true), START, until(), fakeSwapper().swapper), 0);
  assert.equal(sent.length, 0);
});

test("claims wait for the minter to start the epoch, and fail if it does not in time", async () => {
  const { chain, sent } = fakeChain();
  assert.equal(await claims(runOf(chain), START + 604_800n, Date.now() + 1_000, fakeSwapper().swapper), 1);
  assert.equal(sent.length, 0);
});

test("a claim too large for a transaction is planned again, smaller", async () => {
  const { chain, sent } = fakeChain({ gasUsed: 20_000_000n });
  assert.equal(await claims(runOf(chain), START, until(), fakeSwapper().swapper), 1, "it never fits");
  assert.equal(sent.length, 0);
});

const pair = (bribe: Address, token: Address, usd: number, fees = false): Pair => ({
  bribe,
  fees,
  token,
  amount: 1n,
  usd,
});

const swapped = (token: Address) => token !== KVCM;

test("a plan asks the bribe contracts that pay most for the tokens that pay most, as many as the gas allows", () => {
  const pairs = [pair(E1, USDC, 60), pair(I1, USDC, 10, true), pair(I1, KVCM, 30, true), pair(E2, HYDX, 10)];
  const plan = planClaim(pairs, 10_000_000n, 0, swapped)!;
  assert.deepEqual([plan.tokens, plan.fees, plan.bribes, plan.usd], [[USDC, KVCM, HYDX], [I1], [E1, E2], 110]);
  // 1.3M fixed and 0.8M per swap, then 0.3M per bribe contract and token.
  assert.equal(plan.gas, 1_300_000n + 2n * 800_000n + 3n * 900_000n);
  const tight = planClaim(pairs, 3_000_000n, 0, swapped)!;
  assert.deepEqual([tight.tokens, tight.bribes, tight.fees], [[USDC], [E1], [I1]], "one token, two contracts fit");
  assert.equal(planClaim(pairs, 2_000_000n, 0, swapped), undefined, "nothing fits");
  assert.equal(planClaim([], 10_000_000n, 0, swapped), undefined);
});

test("a bribe contract that does not pay for its gas is left out", () => {
  const usdPerGas = 1e-8; // 300k gas costs $0.003, so a contract must pay $0.06
  const plan = planClaim([pair(E1, USDC, 0.07), pair(E2, USDC, 0.05)], 10_000_000n, usdPerGas, swapped)!;
  assert.deepEqual(plan.bribes, [E1]);
});

test("a claim is sent if it collects at least the minimum and its gas costs at most a share of it", () => {
  assert.equal(worthClaiming(MIN_CLAIM_USD, 0), true);
  assert.equal(worthClaiming(MIN_CLAIM_USD - 0.01, 0), false);
  assert.equal(worthClaiming(100, 100 * MAX_GAS_SHARE), true);
  assert.equal(worthClaiming(100, 100 * MAX_GAS_SHARE + 0.01), false);
});

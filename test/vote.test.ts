import assert from "node:assert/strict";
import { test } from "node:test";
import {
  concatHex,
  decodeErrorResult,
  encodeFunctionData,
  encodeAbiParameters,
  parseTransaction,
  toFunctionSelector,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { immutableAbi, klimaModuleAbi } from "../src/abi.ts";
import type { Chain, Client } from "../src/chain.ts";
import {
  broadcastTx,
  castVote,
  heldAt,
  markMined,
  nonceTaken,
  pendingVote,
  prepareVote,
  votedAt,
  VoteSent,
} from "../src/vote.ts";
import { conduitsOf } from "./helpers.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [KLIMA_MODULE, KLIMA, VOTER, POOL, OTHER] = [addr(1), addr(2), addr(3), addr(4), addr(5)] as const;
const signer = privateKeyToAccount(generatePrivateKey());

type Behaviour = {
  nonce?: number;
  congested?: boolean;
  topTip?: bigint;
  reverts?: boolean;
  /** With "lost", waiting for the receipt fails, so the outcome stays unknown. */
  receipt?: "success" | "reverted" | "timeout" | "lost";
  recorded?: Address;
  minedHash?: Hex;
  verifyFails?: boolean;
  sendFails?: boolean;
  /** Nodes refuse the send because a transaction they hold at its nonce pays as much. */
  underpriced?: boolean;
  /** Whether a node holds a transaction this process sent: by default, one does. */
  held?: boolean | "unanswered";
  balance?: bigint;
  revertsAfterRival?: boolean;
  lastVoted?: bigint;
};

const MINED_AT = 1_790_812_801n; // timestamp of block 42, where the receipt lands

function fakeChain(b: Behaviour = {}) {
  const sent: Hex[] = [];
  const simulatedAt: bigint[] = [];
  const simulatedOn: (bigint | undefined)[] = [];
  const simulatedCalls: number[] = [];
  const client = {
    simulateBlocks: async ({
      blocks,
      blockNumber,
      blockTag,
    }: {
      blocks: { blockOverrides: { time: bigint }; calls: unknown[] }[];
      blockNumber?: bigint;
      blockTag?: string;
    }) => {
      assert.equal(blockTag, undefined, "simulates on top of the latest block, or of the one read");
      simulatedAt.push(blocks[0]!.blockOverrides.time);
      simulatedOn.push(blockNumber);
      simulatedCalls.push(blocks[0]!.calls.length);
      const failure = { status: "failure", error: new Error("VoteDelayNotMet()") };
      const fails = b.reverts || (b.revertsAfterRival && blocks[0]!.calls.length > 1);
      return [{ calls: [fails ? failure : { status: "success", gasUsed: 100_000n }] }];
    },
    estimateMaxPriorityFeePerGas: async () => 100n,
    getFeeHistory: async () => ({
      baseFeePerGas: [440n, 445n, 450n],
      gasUsedRatio: [b.congested ? 0.95 : 0.2, 0.3],
      reward: [[b.topTip ?? 400n], [300n]],
    }),
    getTransactionCount: async () => b.nonce ?? 7,
    getBlock: async (args?: { blockNumber?: bigint }) => {
      if (args?.blockNumber === 42n) return { number: 42n, timestamp: MINED_AT };
      assert.equal(args, undefined, "the latest block");
      return { number: 41n, timestamp: 1_790_812_797n };
    },
    getBalance: async () => b.balance ?? 10n ** 18n,
    estimateL1Fee: async () => 5_000n,
    waitForTransactionReceipt: async ({
      hash,
      timeout,
      confirmations,
    }: {
      hash: Hex;
      timeout: number;
      confirmations: number;
    }) => {
      assert.ok(timeout >= 1 && timeout <= 60_000);
      assert.equal(confirmations, 2, "waits for a block on top of the receipt's, so that verification can read it");
      if (b.receipt === "timeout") throw new WaitForTransactionReceiptTimeoutError({ hash });
      if (b.receipt === "lost") throw new Error("connection reset");
      return { status: b.receipt ?? "success", blockNumber: 42n, transactionHash: b.minedHash ?? hash };
    },
    multicall: async ({ contracts, blockNumber }: { contracts: { functionName: string }[]; blockNumber?: bigint }) => {
      assert.equal(blockNumber, 42n, "verification reads the receipt's block");
      if (b.verifyFails) throw new Error("header not found");
      const answer = (functionName: string) =>
        functionName === "poolVote" ? (b.recorded ?? POOL) : functionName === "lastVoted" ? (b.lastVoted ?? 1n) : 1n;
      return contracts.map((c) => answer(c.functionName));
    },
  } as unknown as Client;
  const broadcast = async (signed: Hex) => {
    sent.push(signed);
    if (b.sendFails) {
      throw new Error(
        `no RPC accepted the transaction: ${b.underpriced ? "replacement transaction underpriced" : "timeout"}`,
      );
    }
    return `0x${"ab".repeat(32)}` as Hex;
  };
  const chain: Chain = {
    client,
    bulk: client,
    broadcast,
    known: async (hashes: readonly Hex[]) =>
      hashes.length === 0 ? false : b.held === "unanswered" ? undefined : (b.held ?? true),
    voter: VOTER,
    ve: addr(6),
    conduits: conduitsOf(
      {
        klima: { address: KLIMA, from: signer.address, module: KLIMA_MODULE },
        immutable: { address: IMMUTABLE, from: proposer.address },
      },
      client,
    ),
  };
  return { chain, sent, simulatedAt, simulatedOn, simulatedCalls };
}

const vote = { pools: [POOL], weights: [100n] };
const far = Date.now() + 3_600_000;

test("signs with the confirmed nonce and twice the next base fee plus the tip, then verifies at the receipt block", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  const tx = parseTransaction(sent[0]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 2n * 450n + 100n);
  assert.equal(tx.maxPriorityFeePerGas, 100n, "the tip of a block that is not congested is the estimate");
  assert.equal(tx.gas, 150_000n, "half again the gas the simulation used");
  assert.equal(tx.to, KLIMA_MODULE);
});

test("after a congested block, the tip rises to what the top of it paid, up to 0.1 gwei", async () => {
  const { chain, sent } = fakeChain({ congested: true });
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  const tx = parseTransaction(sent[0]!);
  assert.deepEqual([tx.maxPriorityFeePerGas, tx.maxFeePerGas], [400n, 1_300n]);
  const capped = fakeChain({ congested: true, topTip: 10n ** 18n });
  await castVote(capped.chain, capped.chain.conduits.klima, signer, vote, false, far);
  assert.equal(parseTransaction(capped.sent[0]!).maxPriorityFeePerGas, 100_000_000n);
});

test("a re-vote under the same nonce pays a quarter more than the pending one", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, receipt: "timeout" });
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  assert.equal(parseTransaction(sent[1]!).maxFeePerGas, 1_250n);
  const later = fakeChain({ nonce: 4 });
  await castVote(later.chain, later.chain.conduits.klima, signer, vote, false, far);
  assert.equal(parseTransaction(later.sent[0]!).maxFeePerGas, 1_000n, "a new nonce starts from the estimate");
});

test("a vote prepared with the fees read with the votes reads none of its own", async () => {
  const { chain } = fakeChain({ nonce: 3 });
  let feeReads = 0;
  const { estimateMaxPriorityFeePerGas, getFeeHistory } = chain.client;
  chain.client.estimateMaxPriorityFeePerGas = (async () => (feeReads++, estimateMaxPriorityFeePerGas())) as never;
  chain.client.getFeeHistory = (async (args: never) => (feeReads++, getFeeHistory(args))) as never;
  const target = { time: 1_790_812_799n, lastVoted: 0n };
  const fees = { baseFee: 600n, tip: 70n, congested: false };
  const { tx } = await prepareVote(chain, chain.conduits.klima, signer, vote, false, { target, fees });
  assert.deepEqual([tx.maxFeePerGas, tx.maxPriorityFeePerGas, feeReads], [1_270n, 70n, 0]);
  const read = await prepareVote(chain, chain.conduits.klima, signer, vote, false, { target });
  assert.deepEqual([read.tx.maxFeePerGas, feeReads], [1_000n, 2], "without them, it reads them");
});

test("a transaction this process sent is held while a node has it, and never once in a block or at another nonce", async () => {
  const held = async (b: Behaviour, nonce = 3, mined = false) => {
    const { chain } = fakeChain({ nonce: 3, receipt: "timeout", ...b });
    await castVote(chain, chain.conduits.klima, signer, vote, false, far);
    if (mined) markMined(chain, 3, signer.address);
    return heldAt(chain, signer.address, nonce);
  };
  assert.equal(await held({}), true);
  assert.equal(await held({ held: false }), false, "no node has it");
  assert.equal(await held({ held: "unanswered" }), undefined, "no node answers");
  assert.equal(await held({}, 4), false, "another nonce");
  assert.equal(await held({}, 3, true), false, "in a block");
  assert.equal(await heldAt(fakeChain().chain, signer.address, 3), false, "nothing sent");
});

test("a receipt that does not arrive in time is left to the next pass", async () => {
  const { chain, sent } = fakeChain({ receipt: "timeout" });
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  assert.equal(sent.length, 1);
});

test("does not send once the deadline has passed", async () => {
  const { chain, sent } = fakeChain();
  await assert.rejects(castVote(chain, chain.conduits.klima, signer, vote, false, Date.now() - 1), /out of time/);
  assert.equal(sent.length, 0);
});

test("a reverted or mismatching vote is reported as sent, so it is not retried", async () => {
  const castOn = ({ chain }: ReturnType<typeof fakeChain>) =>
    castVote(chain, chain.conduits.klima, signer, vote, false, far);
  await assert.rejects(castOn(fakeChain({ receipt: "reverted" })), VoteSent);
  await assert.rejects(castOn(fakeChain({ recorded: OTHER })), VoteSent);
});

test("a vote is simulated just after the block it is for, and not sent if it would revert", async () => {
  const { chain, simulatedAt, simulatedOn } = fakeChain();
  await prepareVote(chain, chain.conduits.klima, signer, vote, false, {
    target: { time: 1_790_812_795n, lastVoted: 0n },
  });
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  assert.deepEqual(simulatedAt, [1_790_812_796n, 1_790_812_798n]);
  assert.deepEqual(simulatedOn, [undefined, 41n], "a vote before the last blocks, on the block whose time it takes");
  const reverting = fakeChain({ reverts: true });
  await assert.rejects(
    castVote(reverting.chain, reverting.chain.conduits.klima, signer, vote, false, far),
    /VoteDelayNotMet/,
  );
  assert.equal(reverting.sent.length, 0);
});

test("a dry run signs but never sends", async () => {
  const { chain, sent } = fakeChain();
  await castVote(chain, chain.conduits.klima, signer, vote, true, far);
  assert.equal(sent.length, 0);
});

test("once the Voter shows a later vote than the sent one was decided on, the nonce moves past it", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  const first = await prepareVote(chain, chain.conduits.klima, signer, vote, false, {
    target: { time: 1_790_812_797n, lastVoted: 100n },
  });
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  const next = await prepareVote(chain, chain.conduits.klima, signer, vote, false, {
    target: { time: 1_790_812_799n, lastVoted: 1_790_812_797n },
  });
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [4, 1_000n], "next nonce, no bump: the node lags");
  const still = await prepareVote(chain, chain.conduits.klima, signer, vote, false, {
    target: { time: 1_790_812_799n, lastVoted: 100n },
  });
  assert.deepEqual([still.tx.nonce, still.tx.maxFeePerGas], [3, 1_250n], "not yet in a block: replaced");
  assert.equal(sent.length, 1);
});

test("once the receipt of the transaction sent last was seen, the nonce moves past it, whatever the node says", async () => {
  const { chain } = fakeChain({ nonce: 3 });
  const first = await prepareVote(chain, chain.conduits.klima, signer, vote, false);
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  markMined(chain, 2, signer.address);
  const replacing = await prepareVote(chain, chain.conduits.klima, signer, vote, false);
  assert.deepEqual([replacing.tx.nonce, replacing.tx.maxFeePerGas], [3, 1_250n], "not that one: replaced");
  markMined(chain, 3, signer.address);
  const next = await prepareVote(chain, chain.conduits.klima, signer, vote, false);
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [4, 1_000n], "next nonce, no bump: the node lags");
});

test("a send that fails still counts as this process's vote: it may have reached a node", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, sendFails: true });
  await assert.rejects(castVote(chain, chain.conduits.klima, signer, vote, false, far), /no RPC accepted/);
  await assert.rejects(castVote(chain, chain.conduits.klima, signer, vote, false, far));
  const tx = parseTransaction(sent[1]!);
  assert.deepEqual([tx.nonce, tx.maxFeePerGas], [3, 1_250n], "a quarter more than the recorded fees");
});

test("a send refused as underpriced is sent again at twice its fees, past a transaction this process doesn't know", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, sendFails: true, underpriced: true });
  await assert.rejects(castVote(chain, chain.conduits.klima, signer, vote, false, far), /underpriced/);
  await assert.rejects(castVote(chain, chain.conduits.klima, signer, vote, false, far));
  const tx = parseTransaction(sent[1]!);
  assert.deepEqual([tx.nonce, tx.maxFeePerGas, tx.maxPriorityFeePerGas], [3, 2_000n, 200n]);
});

test("a nonce is taken once the keeper's nonce in the latest block is past it, or a node holds a vote sent at it", async () => {
  const { chain } = fakeChain({ nonce: 4 });
  assert.equal(await nonceTaken(chain, 3, signer.address), true);
  assert.equal(await nonceTaken(chain, 4, signer.address), false);
  chain.client.getTransactionCount = (async () => {
    throw new Error("timeout");
  }) as never;
  assert.equal(await nonceTaken(chain, 3, signer.address), false, "unknown counts as not taken");
  const held = async (b: Behaviour) => {
    const { chain } = fakeChain({ nonce: 4, receipt: "timeout", ...b });
    await castVote(chain, chain.conduits.klima, signer, vote, false, far);
    return nonceTaken(chain, 4, signer.address);
  };
  assert.equal(await held({}), true, "a node holds a vote this process sent at it");
  assert.equal(await held({ held: false }), false, "no node holds it");
  assert.equal(await held({ held: "unanswered" }), false, "no node answers");
});

test("before the last blocks, the keeper must be able to pay for a vote twice; in them, once", async () => {
  const cost = 150_000n * 1_000n + 5_000n; // gas limit times max fee, plus the L1 fee
  const target = { time: 1_790_812_799n, lastVoted: 0n };
  const short = fakeChain({ balance: 2n * cost - 1n });
  await assert.rejects(
    castVote(short.chain, short.chain.conduits.klima, signer, vote, false, far),
    /fund the Klima conduit's keeper: .* needs 300010000:/,
  );
  assert.equal(short.sent.length, 0);
  await prepareVote(short.chain, short.chain.conduits.klima, signer, vote, false, { target });
  const enough = fakeChain({ balance: cost }).chain;
  await prepareVote(enough, enough.conduits.klima, signer, vote, false, { target });
  await assert.rejects(
    (({ chain }) => prepareVote(chain, chain.conduits.klima, signer, vote, false, { target }))(
      fakeChain({ balance: cost - 1n }),
    ),
    /fund the Klima conduit's keeper/,
  );
});

test("a receipt of an earlier vote under the same nonce means this one must be sent again", async () => {
  const { chain } = fakeChain({ minedHash: `0x${"cd".repeat(32)}` });
  await assert.rejects(
    castVote(chain, chain.conduits.klima, signer, vote, false, far),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /replaced/.test(e.message),
  );
});

test("a failed verification after mining is reported as sent", async () => {
  const unverified = fakeChain({ verifyFails: true }).chain;
  await assert.rejects(castVote(unverified, unverified.conduits.klima, signer, vote, false, far), VoteSent);
});

test("the module ABI names the Voter's and the conduit's errors that a simulated vote passes through", () => {
  for (const name of ["EpochFlipInProgress", "VoteDelayNotMet", "EpochStale", "InsufficientVotingPower"]) {
    assert.equal(decodeErrorResult({ abi: klimaModuleAbi, data: toFunctionSelector(`${name}()`) }).errorName, name);
  }
  const role = `0x${"ab".repeat(32)}` as Hex;
  const data = concatHex([
    toFunctionSelector("AccessControlUnauthorizedAccount(address,bytes32)"),
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [KLIMA_MODULE, role]),
  ]);
  const decoded = decodeErrorResult({ abi: klimaModuleAbi, data });
  assert.deepEqual([decoded.errorName, decoded.args], ["AccessControlUnauthorizedAccount", [KLIMA_MODULE, role]]);
});

const proposer = privateKeyToAccount(generatePrivateKey());
const IMMUTABLE = addr(7);

test("the immutable conduit's vote goes from the proposer straight to the conduit", async () => {
  const { chain, sent } = fakeChain({ nonce: 5 });
  await castVote(chain, chain.conduits.immutable, proposer, vote, false, far);
  const tx = parseTransaction(sent[0]!);
  assert.equal(tx.to, IMMUTABLE);
  assert.equal(tx.nonce, 5);
  const moduleVote = encodeFunctionData({
    abi: klimaModuleAbi,
    functionName: "vote",
    args: [vote.pools, vote.weights],
  });
  assert.equal(tx.data, moduleVote, "the same vote(address[],uint256[]) as the module's");
});

test("the keeper's and the proposer's pending votes are tracked apart", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, receipt: "timeout" });
  await castVote(chain, chain.conduits.klima, signer, vote, false, far);
  await castVote(chain, chain.conduits.immutable, proposer, vote, false, far);
  assert.equal(
    parseTransaction(sent[1]!).maxFeePerGas,
    1_000n,
    "the keeper's pending vote does not bump the proposer's",
  );
  await castVote(chain, chain.conduits.immutable, proposer, vote, false, far);
  assert.equal(parseTransaction(sent[2]!).maxFeePerGas, 1_250n, "its own does");
  markMined(chain, 3, proposer.address);
  const keeperNext = await prepareVote(chain, chain.conduits.klima, signer, vote, false);
  assert.deepEqual(
    [keeperNext.tx.nonce, keeperNext.tx.maxFeePerGas],
    [3, 1_250n],
    "the proposer's receipt is not the keeper's",
  );
});

test("a proposer short of funds is told so", async () => {
  const { chain } = fakeChain({ balance: 1n });
  await assert.rejects(
    castVote(chain, chain.conduits.immutable, proposer, vote, false, far),
    /fund the immutable conduit's proposer: 0x/,
  );
});

test("the immutable conduit's ABI names its own errors and the Voter's it passes through", () => {
  for (const name of ["SequencerDown", "EpochStale", "NoVotingPower", "VoteDelayNotMet", "EpochFlipInProgress"]) {
    assert.equal(decodeErrorResult({ abi: immutableAbi, data: toFunctionSelector(`${name}()`) }).errorName, name);
  }
  const data = concatHex([
    toFunctionSelector("NotBetter(uint256,uint256)"),
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n, 4n]),
  ]);
  assert.deepEqual(decodeErrorResult({ abi: immutableAbi, data }).args, [5n, 4n]);
});

test("a vote for the last block before a flip is simulated within its epoch, as the immutable conduit requires", async () => {
  const { chain, simulatedAt } = fakeChain();
  await prepareVote(chain, chain.conduits.klima, signer, vote, false, {
    target: { time: 1_790_812_799n, lastVoted: 0n },
  });
  assert.deepEqual(simulatedAt, [1_790_812_799n], "1_790_812_800 is a flip");
});

test("anyone may vote for the immutable conduit, so a later vote of it does not mean the proposer's was mined", async () => {
  const { chain } = fakeChain({ nonce: 3 });
  const sender = chain.conduits.immutable;
  const first = await prepareVote(chain, sender, proposer, vote, false, {
    target: { time: 1_790_812_797n, lastVoted: 100n },
  });
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  const target = { time: 1_790_812_799n, lastVoted: 1_790_812_797n };
  const next = await prepareVote(chain, sender, proposer, vote, false, { target });
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [3, 1_250n], "replaced, not queued behind");
  markMined(chain, 3, proposer.address);
  const after = await prepareVote(chain, sender, proposer, vote, false, { target });
  assert.equal(after.tx.nonce, 4, "its receipt still counts");
});

test("a conduit's votes are prepared through its own client, which knows what was sent", async () => {
  const { chain, simulatedCalls } = fakeChain({ nonce: 3 });
  const own = fakeChain({ nonce: 3 });
  chain.conduits.immutable = { ...chain.conduits.immutable, client: own.chain.client };
  const target = { time: 1_790_812_797n, lastVoted: 100n };
  const first = await prepareVote(chain, chain.conduits.immutable, proposer, vote, false, { target });
  assert.deepEqual([simulatedCalls.length, own.simulatedCalls.length], [0, 1], "simulated through its own client");
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  const next = await prepareVote(chain, chain.conduits.immutable, proposer, vote, false, {
    target: { ...target, time: 1_790_812_799n },
  });
  assert.deepEqual(
    [next.tx.nonce, next.tx.maxFeePerGas],
    [3, 1_250n],
    "the vote it sent is replaced, not queued behind",
  );
  await prepareVote(chain, chain.conduits.klima, signer, vote, false, { target });
  assert.deepEqual(
    [simulatedCalls.length, own.simulatedCalls.length],
    [1, 2],
    "the Klima conduit's, through the chain's",
  );
});

test("an immutable conduit's vote that another vote beat to its second is decided again, not reported as sent", async () => {
  const beatenTo = (lastVoted?: bigint) => {
    const { chain } = fakeChain({ receipt: "reverted", ...(lastVoted ? { lastVoted } : {}) });
    return chain;
  };
  const beaten = beatenTo(MINED_AT);
  await assert.rejects(
    castVote(beaten, beaten.conduits.immutable, proposer, vote, false, far),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /first in its second/.test(e.message),
  );
  const next = await prepareVote(beaten, beaten.conduits.immutable, proposer, vote, false);
  assert.equal(next.tx.nonce, 8, "past the one the reverted vote took");
  const lost = beatenTo();
  await assert.rejects(
    castVote(lost, lost.conduits.immutable, proposer, vote, false, far),
    VoteSent,
    "reverted for itself",
  );
  const klima = fakeChain({ receipt: "reverted", lastVoted: MINED_AT }).chain;
  await assert.rejects(
    castVote(klima, klima.conduits.klima, signer, vote, false, far),
    VoteSent,
    "only the keeper votes for the Klima one",
  );
});

test("a vote cast a day before the flip is also checked after the Klima conduit's, which may still be pending", async () => {
  const { chain, sent, simulatedCalls } = fakeChain();
  const rival = { conduit: chain.conduits.klima, vote: { pools: [OTHER], weights: [1n] } };
  await castVote(chain, chain.conduits.immutable, proposer, vote, false, far, rival);
  assert.deepEqual(simulatedCalls, [1, 2], "alone, then after the Klima conduit's");
  assert.equal(sent.length, 1);
  const refused = fakeChain({ revertsAfterRival: true });
  await assert.rejects(
    castVote(refused.chain, refused.chain.conduits.immutable, proposer, vote, false, far, rival),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /after the Klima conduit's/.test(e.message),
  );
  assert.equal(refused.sent.length, 0, "not sent, and retried");
});

test("with a rival vote, the vote is also simulated after it, and refused if it would revert there", async () => {
  const target = { time: 1_790_812_797n, lastVoted: 0n };
  const ok = fakeChain();
  const rival = { conduit: ok.chain.conduits.klima, vote: { pools: [OTHER], weights: [1n] } };
  await prepareVote(ok.chain, ok.chain.conduits.immutable, proposer, vote, false, { target, rival });
  assert.deepEqual(ok.simulatedCalls, [1, 2], "alone, then after the rival's");
  const refused = fakeChain({ revertsAfterRival: true });
  await assert.rejects(
    prepareVote(refused.chain, refused.chain.conduits.immutable, proposer, vote, false, { target, rival }),
    /would revert after the Klima conduit's/,
  );
});

test("another conduit's vote is checked after the keeper's while that one may still land, and only then", async () => {
  const pendingAfter = async (b: Behaviour) => {
    const { chain } = fakeChain(b);
    await castVote(chain, chain.conduits.klima, signer, vote, false, far).catch(() => undefined);
    return pendingVote(chain, chain.conduits.klima);
  };
  assert.deepEqual(await pendingAfter({ nonce: 3, receipt: "lost" }), vote, "its outcome unknown");
  assert.deepEqual(await pendingAfter({ nonce: 3, receipt: "timeout" }), vote, "not in a block yet");
  assert.deepEqual(await pendingAfter({ nonce: 3, sendFails: true }), vote, "a failed send that reached a node");
  assert.equal(await pendingAfter({ nonce: 3, sendFails: true, held: false }), undefined, "one no node holds");
  assert.deepEqual(await pendingAfter({ nonce: 3, receipt: "timeout", held: "unanswered" }), vote, "nodes silent");
  assert.equal(await pendingAfter({ nonce: 3, receipt: "reverted" }), undefined, "it reverted");
  assert.equal(await pendingAfter({ nonce: 3 }), undefined, "it is in force");
  assert.equal(await pendingAfter({ nonce: 3, reverts: true }), undefined, "it was never sent");
  const used = async () => {
    const { chain } = fakeChain({ nonce: 3, receipt: "timeout" });
    await castVote(chain, chain.conduits.klima, signer, vote, false, far);
    chain.client.getTransactionCount = (async () => 4) as never;
    return pendingVote(chain, chain.conduits.klima);
  };
  assert.equal(await used(), undefined, "a block holds a transaction at its nonce");
});

test("the immutable conduit's vote in force is the proposer's only if the conduit accepted it from the proposer in that second", async () => {
  const VOTED = 1_790_812_000n; // timestamp of blocks 100 to 104, 200 ms apart as on Base
  type Filter = {
    address: Address;
    eventName: string;
    args: { proposer: Address };
    fromBlock: bigint;
    toBlock: bigint;
  };
  const acceptedFrom = async (proposers: Address[]) => {
    const client = {
      getBlock: async (args?: { blockNumber?: bigint }) => {
        const number = args?.blockNumber ?? 130n;
        const ms = VOTED * 1000n + (number - 100n) * 200n;
        return { number, timestamp: ms / 1000n, timestampMs: `0x${ms.toString(16)}` };
      },
      getContractEvents: async ({ address, eventName, args, fromBlock, toBlock }: Filter) => {
        assert.deepEqual([address, eventName, fromBlock, toBlock], [IMMUTABLE, "VoteAccepted", 100n, 104n]);
        return proposers.filter((p) => p === args.proposer).map(() => ({}));
      },
    } as unknown as Client;
    const conduits = conduitsOf(
      {
        klima: { address: KLIMA, from: signer.address, module: KLIMA_MODULE },
        immutable: { address: IMMUTABLE, from: proposer.address },
      },
      client,
    );
    return votedAt({ client, conduits } as unknown as Chain, conduits.immutable, VOTED);
  };
  assert.equal(await acceptedFrom([proposer.address]), true);
  assert.equal(await acceptedFrom([OTHER]), false, "another's vote");
});

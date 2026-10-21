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
import { immutableAbi, moduleAbi } from "../src/abi.ts";
import type { Chain, Client } from "../src/chain.ts";
import {
  broadcastTx,
  castVote,
  klimaSender,
  markMined,
  nonceTaken,
  pendingVote,
  prepareVote,
  v2Sender,
  votedAt,
  VoteSent,
} from "../src/vote.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [MODULE, CONDUIT, VOTER, POOL, OTHER] = [addr(1), addr(2), addr(3), addr(4), addr(5)] as const;
const signer = privateKeyToAccount(generatePrivateKey());

type Behaviour = {
  nonce?: number;
  pending?: number;
  congested?: boolean;
  topTip?: bigint;
  reverts?: boolean;
  /** "lost": the wait for it fails, so its outcome is unknown. */
  receipt?: "success" | "reverted" | "timeout" | "lost";
  recorded?: Address;
  minedHash?: Hex;
  verifyFails?: boolean;
  sendFails?: boolean;
  balance?: bigint;
  revertsAfterRival?: boolean;
  /** The conduit's `lastVoted` as of the receipt's block. */
  lastVoted?: bigint;
};

const MINED_AT = 1_790_812_801n; // the timestamp of block 42, the receipt's

/** A client that answers castVote's reads and records what it is asked to send. */
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
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === "pending" ? (b.pending ?? b.nonce ?? 7) : (b.nonce ?? 7),
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
    if (b.sendFails) throw new Error("no RPC accepted the transaction: timeout");
    return `0x${"ab".repeat(32)}` as Hex;
  };
  const chain: Chain = {
    client,
    bulk: client,
    v2Client: client,
    broadcast,
    module: MODULE,
    conduit: CONDUIT,
    keeper: signer.address,
    voter: VOTER,
    ve: addr(6),
  };
  return { chain, sent, simulatedAt, simulatedOn, simulatedCalls };
}

const vote = { pools: [POOL], weights: [100n] };
const far = Date.now() + 3_600_000;

test("signs with the confirmed nonce and twice the next base fee plus the tip, then verifies at the receipt block", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  await castVote(chain, signer, vote, false, far);
  const tx = parseTransaction(sent[0]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 2n * 450n + 100n);
  assert.equal(tx.maxPriorityFeePerGas, 100n, "the tip of a block that is not congested is the estimate");
  assert.equal(tx.gas, 150_000n, "half again the gas the simulation used");
  assert.equal(tx.to, MODULE);
});

test("after a congested block, the tip rises to what the top of it paid, up to 0.1 gwei", async () => {
  const { chain, sent } = fakeChain({ congested: true });
  await castVote(chain, signer, vote, false, far);
  const tx = parseTransaction(sent[0]!);
  assert.deepEqual([tx.maxPriorityFeePerGas, tx.maxFeePerGas], [400n, 1_300n]);
  const capped = fakeChain({ congested: true, topTip: 10n ** 18n });
  await castVote(capped.chain, signer, vote, false, far);
  assert.equal(parseTransaction(capped.sent[0]!).maxPriorityFeePerGas, 100_000_000n);
});

test("a re-vote under the same nonce pays a quarter more than the pending one", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, receipt: "timeout" });
  await castVote(chain, signer, vote, false, far);
  await castVote(chain, signer, vote, false, far);
  assert.equal(parseTransaction(sent[1]!).maxFeePerGas, 1_250n);
  const later = fakeChain({ nonce: 4 });
  await castVote(later.chain, signer, vote, false, far);
  assert.equal(parseTransaction(later.sent[0]!).maxFeePerGas, 1_000n, "a new nonce starts from the estimate");
});

test("a receipt that does not arrive in time is left to the next pass", async () => {
  const { chain, sent } = fakeChain({ receipt: "timeout" });
  await castVote(chain, signer, vote, false, far);
  assert.equal(sent.length, 1);
});

test("does not send once the deadline has passed", async () => {
  const { chain, sent } = fakeChain();
  await assert.rejects(castVote(chain, signer, vote, false, Date.now() - 1), /out of time/);
  assert.equal(sent.length, 0);
});

test("a reverted or mismatching vote is reported as sent, so it is not retried", async () => {
  await assert.rejects(castVote(fakeChain({ receipt: "reverted" }).chain, signer, vote, false, far), VoteSent);
  await assert.rejects(castVote(fakeChain({ recorded: OTHER }).chain, signer, vote, false, far), VoteSent);
});

test("a vote is simulated just after the block it is for, and not sent if it would revert", async () => {
  const { chain, simulatedAt, simulatedOn } = fakeChain();
  await prepareVote(chain, signer, vote, false, { time: 1_790_812_795n, lastVoted: 0n });
  await castVote(chain, signer, vote, false, far);
  assert.deepEqual(simulatedAt, [1_790_812_796n, 1_790_812_798n]);
  assert.deepEqual(simulatedOn, [undefined, 41n], "a vote before the last blocks, on the block whose time it takes");
  const reverting = fakeChain({ reverts: true });
  await assert.rejects(castVote(reverting.chain, signer, vote, false, far), /VoteDelayNotMet/);
  assert.equal(reverting.sent.length, 0);
});

test("a dry run signs but never sends", async () => {
  const { chain, sent } = fakeChain();
  await castVote(chain, signer, vote, true, far);
  assert.equal(sent.length, 0);
});

test("a pending vote of unknown fees is replaced at twice the fees; one this process sent at a quarter more", async () => {
  const unknown = fakeChain({ nonce: 3, pending: 4 });
  await castVote(unknown.chain, signer, vote, false, far);
  const replacing = parseTransaction(unknown.sent[0]!);
  assert.deepEqual([replacing.nonce, replacing.maxFeePerGas], [3, 2_000n], "replaced, not queued behind");
  const own = fakeChain({ nonce: 3, pending: 3, receipt: "timeout" });
  await castVote(own.chain, signer, vote, false, far);
  own.chain.client.getTransactionCount = (async ({ blockTag }: { blockTag: string }) =>
    blockTag === "pending" ? 4 : 3) as never;
  await castVote(own.chain, signer, vote, false, far);
  const tx = parseTransaction(own.sent[1]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 1_250n);
});

test("once the Voter shows a later vote than the sent one was decided on, the nonce moves past it", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  const first = await prepareVote(chain, signer, vote, false, { time: 1_790_812_797n, lastVoted: 100n });
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  const next = await prepareVote(chain, signer, vote, false, { time: 1_790_812_799n, lastVoted: 1_790_812_797n });
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [4, 1_000n], "next nonce, no bump: the node lags");
  const still = await prepareVote(chain, signer, vote, false, { time: 1_790_812_799n, lastVoted: 100n });
  assert.deepEqual([still.tx.nonce, still.tx.maxFeePerGas], [3, 1_250n], "not yet in a block: replaced");
  assert.equal(sent.length, 1);
});

test("once the receipt of the transaction sent last was seen, the nonce moves past it, whatever the node says", async () => {
  const { chain } = fakeChain({ nonce: 3 });
  const first = await prepareVote(chain, signer, vote, false);
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  markMined(chain, 2);
  const replacing = await prepareVote(chain, signer, vote, false);
  assert.deepEqual([replacing.tx.nonce, replacing.tx.maxFeePerGas], [3, 1_250n], "not that one: replaced");
  markMined(chain, 3);
  const next = await prepareVote(chain, signer, vote, false);
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [4, 1_000n], "next nonce, no bump: the node lags");
});

test("a send that fails still counts as this process's vote: it may have reached a node", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, sendFails: true });
  await assert.rejects(castVote(chain, signer, vote, false, far), /no RPC accepted/);
  chain.client.getTransactionCount = (async ({ blockTag }: { blockTag: string }) =>
    blockTag === "pending" ? 4 : 3) as never;
  await assert.rejects(castVote(chain, signer, vote, false, far));
  const tx = parseTransaction(sent[1]!);
  assert.deepEqual([tx.nonce, tx.maxFeePerGas], [3, 1_250n], "a quarter more than the recorded fees");
});

test("a nonce is taken once the keeper's nonce in the block being built is past it", async () => {
  const { chain } = fakeChain({ nonce: 3, pending: 4 });
  assert.equal(await nonceTaken(chain, 3), true);
  assert.equal(await nonceTaken(chain, 4), false);
  chain.client.getTransactionCount = (async () => {
    throw new Error("timeout");
  }) as never;
  assert.equal(await nonceTaken(chain, 3), false, "unknown counts as not taken");
});

test("before the last blocks, the keeper must be able to pay for a vote twice; in them, once", async () => {
  const cost = 150_000n * 1_000n + 5_000n; // gas times max fee, plus the L1 fee
  const target = { time: 1_790_812_799n, lastVoted: 0n };
  const short = fakeChain({ balance: 2n * cost - 1n });
  await assert.rejects(castVote(short.chain, signer, vote, false, far), /fund the keeper: .* needs 300010000:/);
  assert.equal(short.sent.length, 0);
  await prepareVote(short.chain, signer, vote, false, target);
  await prepareVote(fakeChain({ balance: cost }).chain, signer, vote, false, target);
  await assert.rejects(
    prepareVote(fakeChain({ balance: cost - 1n }).chain, signer, vote, false, target),
    /fund the keeper/,
  );
});

test("a receipt of an earlier vote under the same nonce means this one must be sent again", async () => {
  const { chain } = fakeChain({ minedHash: `0x${"cd".repeat(32)}` });
  await assert.rejects(
    castVote(chain, signer, vote, false, far),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /replaced/.test(e.message),
  );
});

test("a failed verification after mining is reported as sent", async () => {
  await assert.rejects(castVote(fakeChain({ verifyFails: true }).chain, signer, vote, false, far), VoteSent);
});

test("the module ABI names the Voter's and the conduit's errors that a simulated vote passes through", () => {
  for (const name of ["EpochFlipInProgress", "VoteDelayNotMet", "EpochStale", "InsufficientVotingPower"]) {
    assert.equal(decodeErrorResult({ abi: moduleAbi, data: toFunctionSelector(`${name}()`) }).errorName, name);
  }
  const role = `0x${"ab".repeat(32)}` as Hex;
  const data = concatHex([
    toFunctionSelector("AccessControlUnauthorizedAccount(address,bytes32)"),
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [MODULE, role]),
  ]);
  const decoded = decodeErrorResult({ abi: moduleAbi, data });
  assert.deepEqual([decoded.errorName, decoded.args], ["AccessControlUnauthorizedAccount", [MODULE, role]]);
});

const proposer = privateKeyToAccount(generatePrivateKey());
const V2 = addr(7);

test("the immutable conduit's vote goes from the proposer straight to the conduit", async () => {
  const { chain, sent } = fakeChain({ nonce: 5 });
  chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  await castVote(chain, proposer, vote, false, far, v2Sender(chain));
  const tx = parseTransaction(sent[0]!);
  assert.equal(tx.to, V2);
  assert.equal(tx.nonce, 5);
  const moduleVote = encodeFunctionData({ abi: moduleAbi, functionName: "vote", args: [vote.pools, vote.weights] });
  assert.equal(tx.data, moduleVote, "the same vote(address[],uint256[]) as the module's");
  assert.throws(() => v2Sender(fakeChain().chain), /no immutable conduit/);
});

test("the keeper's and the proposer's pending votes are tracked apart", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, receipt: "timeout" });
  chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  await castVote(chain, signer, vote, false, far);
  await castVote(chain, proposer, vote, false, far, v2Sender(chain));
  assert.equal(
    parseTransaction(sent[1]!).maxFeePerGas,
    1_000n,
    "the keeper's pending vote does not bump the proposer's",
  );
  await castVote(chain, proposer, vote, false, far, v2Sender(chain));
  assert.equal(parseTransaction(sent[2]!).maxFeePerGas, 1_250n, "its own does");
  markMined(chain, 3, proposer.address);
  const keeperNext = await prepareVote(chain, signer, vote, false);
  assert.deepEqual(
    [keeperNext.tx.nonce, keeperNext.tx.maxFeePerGas],
    [3, 1_250n],
    "the proposer's receipt is not the keeper's",
  );
});

test("a proposer short of funds is told so", async () => {
  const { chain } = fakeChain({ balance: 1n });
  chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  await assert.rejects(castVote(chain, proposer, vote, false, far, v2Sender(chain)), /fund the proposer: 0x/);
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
  await prepareVote(chain, signer, vote, false, { time: 1_790_812_799n, lastVoted: 0n });
  assert.deepEqual(simulatedAt, [1_790_812_799n], "1_790_812_800 is a flip");
});

test("anyone may vote for the immutable conduit, so a later vote of it does not mean the proposer's was mined", async () => {
  const { chain } = fakeChain({ nonce: 3 });
  chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  const sender = v2Sender(chain);
  const first = await prepareVote(chain, proposer, vote, false, { time: 1_790_812_797n, lastVoted: 100n }, sender);
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  const target = { time: 1_790_812_799n, lastVoted: 1_790_812_797n };
  const next = await prepareVote(chain, proposer, vote, false, target, sender);
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [3, 1_250n], "replaced, not queued behind");
  markMined(chain, 3, proposer.address);
  const after = await prepareVote(chain, proposer, vote, false, target, sender);
  assert.equal(after.tx.nonce, 4, "its receipt still counts");
});

test("the immutable conduit's votes are prepared through a client of their own, which knows what was sent", async () => {
  const { chain, simulatedCalls } = fakeChain({ nonce: 3 });
  const own = fakeChain({ nonce: 3 });
  chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  chain.v2Client = own.chain.client;
  const target = { time: 1_790_812_797n, lastVoted: 100n };
  const first = await prepareVote(chain, proposer, vote, false, target, v2Sender(chain));
  assert.deepEqual([simulatedCalls.length, own.simulatedCalls.length], [0, 1], "simulated through its own client");
  await broadcastTx(chain, { ...first, signed: first.signed! }, far);
  const next = await prepareVote(chain, proposer, vote, false, { ...target, time: 1_790_812_799n }, v2Sender(chain));
  assert.deepEqual(
    [next.tx.nonce, next.tx.maxFeePerGas],
    [3, 1_250n],
    "the vote it sent is replaced, not queued behind",
  );
  await prepareVote(chain, signer, vote, false, target);
  assert.deepEqual(
    [simulatedCalls.length, own.simulatedCalls.length],
    [1, 2],
    "the Klima conduit's, through the chain's",
  );
});

test("an immutable conduit's vote that another vote beat to its block is decided again, not reported as sent", async () => {
  const beatenTo = (lastVoted?: bigint) => {
    const { chain } = fakeChain({ receipt: "reverted", ...(lastVoted ? { lastVoted } : {}) });
    chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
    return chain;
  };
  const beaten = beatenTo(MINED_AT);
  await assert.rejects(
    castVote(beaten, proposer, vote, false, far, v2Sender(beaten)),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /first in its block/.test(e.message),
  );
  const next = await prepareVote(beaten, proposer, vote, false, undefined, v2Sender(beaten));
  assert.equal(next.tx.nonce, 8, "past the one the reverted vote took");
  const lost = beatenTo();
  await assert.rejects(castVote(lost, proposer, vote, false, far, v2Sender(lost)), VoteSent, "reverted for itself");
  const klima = fakeChain({ receipt: "reverted", lastVoted: MINED_AT }).chain;
  await assert.rejects(castVote(klima, signer, vote, false, far), VoteSent, "only the keeper votes for the Klima one");
});

test("a vote cast a day before the flip is also checked after the Klima conduit's, which may still be pending", async () => {
  const { chain, sent, simulatedCalls } = fakeChain();
  chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  const rival = { sender: klimaSender(chain), vote: { pools: [OTHER], weights: [1n] } };
  await castVote(chain, proposer, vote, false, far, v2Sender(chain), rival);
  assert.deepEqual(simulatedCalls, [1, 2], "alone, then after the Klima conduit's");
  assert.equal(sent.length, 1);
  const refused = fakeChain({ revertsAfterRival: true });
  refused.chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  await assert.rejects(
    castVote(refused.chain, proposer, vote, false, far, v2Sender(refused.chain), rival),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /after the keeper's/.test(e.message),
  );
  assert.equal(refused.sent.length, 0, "not sent, and retried");
});

test("with a rival vote, the vote is also simulated after it, and refused if it would revert there", async () => {
  const target = { time: 1_790_812_797n, lastVoted: 0n };
  const ok = fakeChain();
  ok.chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  const rival = { sender: klimaSender(ok.chain), vote: { pools: [OTHER], weights: [1n] } };
  await prepareVote(ok.chain, proposer, vote, false, target, v2Sender(ok.chain), rival);
  assert.deepEqual(ok.simulatedCalls, [1, 2], "alone, then after the rival's");
  const refused = fakeChain({ revertsAfterRival: true });
  refused.chain.v2 = { conduit: V2, proposer: proposer.address, priced: [] };
  await assert.rejects(
    prepareVote(refused.chain, proposer, vote, false, target, v2Sender(refused.chain), rival),
    /would revert after the keeper's/,
  );
});

test("another conduit's vote is checked after the keeper's while that one may still land, and only then", async () => {
  const pendingAfter = async (b: Behaviour) => {
    const { chain } = fakeChain(b);
    await castVote(chain, signer, vote, false, far).catch(() => undefined);
    return pendingVote(chain, klimaSender(chain));
  };
  assert.deepEqual(await pendingAfter({ nonce: 3, pending: 4, receipt: "lost" }), vote, "its outcome unknown");
  assert.deepEqual(await pendingAfter({ nonce: 3, pending: 4, receipt: "timeout" }), vote, "not in a block yet");
  assert.deepEqual(await pendingAfter({ nonce: 3, pending: 4, sendFails: true }), vote, "a node has it after all");
  assert.equal(await pendingAfter({ nonce: 3, sendFails: true }), undefined, "no node has it");
  assert.equal(await pendingAfter({ nonce: 3, pending: 4, receipt: "reverted" }), undefined, "it reverted");
  assert.equal(await pendingAfter({ nonce: 3, pending: 4 }), undefined, "it is in force");
  assert.equal(await pendingAfter({ nonce: 3, pending: 4, reverts: true }), undefined, "it was never sent");
});

test("the immutable conduit's vote in force is the proposer's only if the conduit accepted it from the proposer", async () => {
  const VOTED = 1_790_812_000n; // the timestamp of block 100
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
        return { number, timestamp: VOTED + (number - 100n) * 2n };
      },
      getContractEvents: async ({ address, eventName, args, fromBlock, toBlock }: Filter) => {
        assert.deepEqual([address, eventName, fromBlock, toBlock], [V2, "VoteAccepted", 100n, 100n]);
        return proposers.filter((p) => p === args.proposer).map(() => ({}));
      },
    } as unknown as Client;
    const chain = { client, v2Client: client, v2: { conduit: V2, proposer: proposer.address, priced: [] } };
    return votedAt(chain as unknown as Chain, v2Sender(chain as unknown as Chain), VOTED);
  };
  assert.equal(await acceptedFrom([proposer.address]), true);
  assert.equal(await acceptedFrom([OTHER]), false, "another's vote");
});

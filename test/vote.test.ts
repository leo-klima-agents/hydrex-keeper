import assert from "node:assert/strict";
import { test } from "node:test";
import {
  concatHex,
  decodeErrorResult,
  encodeAbiParameters,
  parseTransaction,
  toFunctionSelector,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { moduleAbi } from "../src/abi.ts";
import type { Chain, Client } from "../src/chain.ts";
import { broadcastVote, castVote, prepareVote, VoteSent } from "../src/vote.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [MODULE, CONDUIT, VOTER, POOL, OTHER] = [addr(1), addr(2), addr(3), addr(4), addr(5)] as const;
const signer = privateKeyToAccount(generatePrivateKey());

type Behaviour = {
  nonce?: number;
  pending?: number;
  congested?: boolean;
  topTip?: bigint;
  reverts?: boolean;
  receipt?: "success" | "reverted" | "timeout";
  recorded?: Address;
  minedHash?: Hex;
  verifyFails?: boolean;
  sendFails?: boolean;
};

/** A client that answers castVote's reads and records what it is asked to send. */
function fakeChain(b: Behaviour = {}) {
  const sent: Hex[] = [];
  const simulatedAt: bigint[] = [];
  const client = {
    simulateBlocks: async ({
      blocks,
      blockTag,
    }: {
      blocks: { blockOverrides: { time: bigint } }[];
      blockTag?: string;
    }) => {
      assert.equal(blockTag, undefined, "simulates on top of the latest block");
      simulatedAt.push(blocks[0]!.blockOverrides.time);
      const failure = { status: "failure", error: new Error("VoteDelayNotMet()") };
      return [{ calls: [b.reverts ? failure : { status: "success", gasUsed: 100_000n }] }];
    },
    estimateMaxPriorityFeePerGas: async () => 100n,
    getFeeHistory: async () => ({
      baseFeePerGas: [440n, 445n, 450n],
      gasUsedRatio: [b.congested ? 0.95 : 0.2, 0.3],
      reward: [[b.topTip ?? 400n], [300n]],
    }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === "pending" ? (b.pending ?? b.nonce ?? 7) : (b.nonce ?? 7),
    getBlock: async (args?: object) => {
      assert.equal(args, undefined, "the latest block");
      return { timestamp: 1_790_812_797n };
    },
    getBalance: async () => 10n ** 18n,
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
      return { status: b.receipt ?? "success", blockNumber: 42n, transactionHash: b.minedHash ?? hash };
    },
    multicall: async ({ contracts, blockNumber }: { contracts: { functionName: string }[]; blockNumber?: bigint }) => {
      assert.equal(blockNumber, 42n, "verification reads the receipt's block");
      if (b.verifyFails) throw new Error("header not found");
      return contracts.map((c) => (c.functionName === "poolVote" ? (b.recorded ?? POOL) : 1n));
    },
  } as unknown as Client;
  const broadcast = async (signed: Hex) => {
    sent.push(signed);
    if (b.sendFails) throw new Error("no RPC accepted the vote: timeout");
    return `0x${"ab".repeat(32)}` as Hex;
  };
  const chain: Chain = {
    client,
    broadcast,
    module: MODULE,
    conduit: CONDUIT,
    keeper: signer.address,
    voter: VOTER,
    ve: addr(6),
  };
  return { chain, sent, simulatedAt };
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
  const { chain, simulatedAt } = fakeChain();
  await prepareVote(chain, signer, vote, false, { time: 1_790_812_799n, lastVoted: 0n });
  await castVote(chain, signer, vote, false, far);
  assert.deepEqual(simulatedAt, [1_790_812_800n, 1_790_812_798n]);
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
  await broadcastVote(chain, { ...first, signed: first.signed! }, far);
  const next = await prepareVote(chain, signer, vote, false, { time: 1_790_812_799n, lastVoted: 1_790_812_797n });
  assert.deepEqual([next.tx.nonce, next.tx.maxFeePerGas], [4, 1_000n], "next nonce, no bump: the node lags");
  const still = await prepareVote(chain, signer, vote, false, { time: 1_790_812_799n, lastVoted: 100n });
  assert.deepEqual([still.tx.nonce, still.tx.maxFeePerGas], [3, 1_250n], "not yet in a block: replaced");
  assert.equal(sent.length, 1);
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
  for (const name of ["EpochFlipInProgress", "VoteDelayNotMet", "InsufficientVotingPower"]) {
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

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
import { castVote, confirmVote, VoteSent } from "../src/vote.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [MODULE, CONDUIT, VOTER, POOL, OTHER] = [addr(1), addr(2), addr(3), addr(4), addr(5)] as const;
const signer = privateKeyToAccount(generatePrivateKey());

type Behaviour = {
  nonce?: number;
  pending?: number;
  receipt?: "success" | "reverted" | "timeout";
  blockTimestamp?: bigint;
  recorded?: Address;
  fee?: bigint;
  minedHash?: Hex;
  verifyFails?: boolean;
  sendFails?: boolean;
};

/** A client that answers castVote's reads and records what it is asked to send. */
function fakeChain(b: Behaviour = {}) {
  const sent: Hex[] = [];
  const client = {
    simulateContract: async () => ({ result: undefined }),
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: b.fee ?? 1_000n, maxPriorityFeePerGas: (b.fee ?? 1_000n) / 10n }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === "pending" ? (b.pending ?? b.nonce ?? 7) : (b.nonce ?? 7),
    getBalance: async () => 10n ** 18n,
    estimateL1Fee: async () => 5_000n,
    getBlock: async () => ({ timestamp: b.blockTimestamp ?? 0n }),
    waitForTransactionReceipt: async ({ hash, timeout }: { hash: Hex; timeout: number }) => {
      assert.ok(timeout >= 1 && timeout <= 60_000);
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
  return { chain, sent };
}

const vote = { pools: [POOL], weights: [100n] };
const flip = 1_790_812_800n;
const far = Date.now() + 3_600_000;
const cast = (chain: Chain) => castVote(chain, signer, vote, false, far);
const castAndConfirm = async (chain: Chain) => confirmVote(chain, (await cast(chain))!, flip, far);

test("signs with the confirmed nonce and the estimated fees, then verifies at the receipt block", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  await castAndConfirm(chain);
  const tx = parseTransaction(sent[0]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 1_000n);
  assert.equal(tx.gas, 120_000n);
  assert.equal(tx.to, MODULE);
});

test("a re-vote under the same nonce pays a quarter more than the pending one", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  await cast(chain);
  await cast(chain);
  assert.equal(parseTransaction(sent[1]!).maxFeePerGas, 1_250n);
  const later = fakeChain({ nonce: 4 });
  await cast(later.chain);
  assert.equal(parseTransaction(later.sent[0]!).maxFeePerGas, 1_000n, "a new nonce starts from the estimate");
});

test("a receipt that does not arrive in time is left to the next pass", async () => {
  const { chain, sent } = fakeChain({ receipt: "timeout" });
  await castAndConfirm(chain);
  assert.equal(sent.length, 1);
});

test("a reverted or mismatching vote is reported as sent, so it is not retried", async () => {
  await assert.rejects(castAndConfirm(fakeChain({ receipt: "reverted" }).chain), VoteSent);
  await assert.rejects(castAndConfirm(fakeChain({ recorded: OTHER }).chain), VoteSent);
});

test("a vote that reverts in a block at or after the flip was too late, which is only logged", async () => {
  await castAndConfirm(fakeChain({ receipt: "reverted", blockTimestamp: flip }).chain);
});

test("a dry run signs but never sends", async () => {
  const { chain, sent } = fakeChain();
  assert.equal(await castVote(chain, signer, vote, true, far), undefined);
  assert.equal(sent.length, 0);
});

test("a pending vote of unknown fees is replaced at twice the estimate; one this process sent at a quarter more", async () => {
  const unknown = fakeChain({ nonce: 3, pending: 4 });
  await cast(unknown.chain);
  const replacing = parseTransaction(unknown.sent[0]!);
  assert.deepEqual([replacing.nonce, replacing.maxFeePerGas], [3, 2_000n], "replaced, not queued behind");
  const own = fakeChain({ nonce: 3, pending: 3 });
  await cast(own.chain);
  own.chain.client.getTransactionCount = (async ({ blockTag }: { blockTag: string }) =>
    blockTag === "pending" ? 4 : 3) as never;
  await cast(own.chain);
  const tx = parseTransaction(own.sent[1]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 1_250n);
});

test("a send that fails still counts as this process's vote: it may have reached a node", async () => {
  const { chain, sent } = fakeChain({ nonce: 3, sendFails: true });
  await assert.rejects(cast(chain), /no RPC accepted/);
  chain.client.getTransactionCount = (async ({ blockTag }: { blockTag: string }) =>
    blockTag === "pending" ? 4 : 3) as never;
  await assert.rejects(cast(chain));
  const tx = parseTransaction(sent[1]!);
  assert.deepEqual([tx.nonce, tx.maxFeePerGas], [3, 1_250n], "a quarter more than the recorded fees");
});

test("a send refused because this process's pending vote was mined meanwhile is not an error", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  await cast(chain);
  const nonces = [3, 3, 4];
  chain.client.getTransactionCount = (async () => nonces.shift()) as never;
  chain.broadcast = async () => {
    throw new Error("no RPC accepted the vote: nonce too low");
  };
  assert.equal(await cast(chain), undefined);
  assert.deepEqual([sent.length, nonces.length], [1, 0]);
});

test("a receipt of an earlier vote under the same nonce means this one must be sent again", async () => {
  const { chain } = fakeChain({ minedHash: `0x${"cd".repeat(32)}` });
  await assert.rejects(
    castAndConfirm(chain),
    (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /replaced/.test(e.message),
  );
});

test("a failed verification after mining is reported as sent", async () => {
  await assert.rejects(castAndConfirm(fakeChain({ verifyFails: true }).chain), VoteSent);
});

test("the module ABI names the Voter's and the conduit's errors that a simulated vote passes through", () => {
  for (const name of ["EpochFlipInProgress", "EpochStale", "VoteDelayNotMet", "InsufficientVotingPower"]) {
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

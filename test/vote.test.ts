import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeErrorResult, parseTransaction, toFunctionSelector, WaitForTransactionReceiptTimeoutError, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { moduleAbi } from "../src/abi.ts";
import type { Chain, Client } from "../src/chain.ts";
import { castVote, VoteSent } from "../src/vote.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [MODULE, CONDUIT, VOTER, POOL, OTHER] = [addr(1), addr(2), addr(3), addr(4), addr(5)] as const;
const signer = privateKeyToAccount(generatePrivateKey());

type Behaviour = { nonce?: number; pending?: number; receipt?: "success" | "reverted" | "timeout"; recorded?: Address; fee?: bigint; minedHash?: Hex; verifyFails?: boolean };

/** A client that answers castVote's reads and records what it is asked to send. */
function fakeChain(b: Behaviour = {}) {
  const sent: Hex[] = [];
  const client = {
    simulateContract: async () => ({ result: undefined }),
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: b.fee ?? 1_000n, maxPriorityFeePerGas: (b.fee ?? 1_000n) / 10n }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === "pending" ? (b.pending ?? b.nonce ?? 7) : (b.nonce ?? 7)),
    getBalance: async () => 10n ** 18n,
    estimateL1Fee: async () => 5_000n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      return `0x${"ab".repeat(32)}` as Hex;
    },
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
  const chain: Chain = { client, module: MODULE, conduit: CONDUIT, keeper: signer.address, voter: VOTER, ve: addr(6) };
  return { chain, sent };
}

const vote = { pools: [POOL], weights: [100n] };
const far = Date.now() + 3_600_000;

test("signs with the confirmed nonce and the estimated fees, then verifies at the receipt block", async () => {
  const { chain, sent } = fakeChain({ nonce: 3 });
  await castVote(chain, signer, vote, false, far);
  const tx = parseTransaction(sent[0]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 1_000n);
  assert.equal(tx.gas, 120_000n);
  assert.equal(tx.to, MODULE);
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

test("a dry run signs but never sends", async () => {
  const { chain, sent } = fakeChain();
  await castVote(chain, signer, vote, true, far);
  assert.equal(sent.length, 0);
});

test("a pending vote of unknown fees is queued behind; one this process sent is replaced", async () => {
  const queued = fakeChain({ nonce: 3, pending: 4 });
  await castVote(queued.chain, signer, vote, false, far);
  assert.equal(parseTransaction(queued.sent[0]!).nonce, 4);
  const own = fakeChain({ nonce: 3, pending: 3, receipt: "timeout" });
  await castVote(own.chain, signer, vote, false, far);
  own.chain.client.getTransactionCount = (async ({ blockTag }: { blockTag: string }) => (blockTag === "pending" ? 4 : 3)) as never;
  await castVote(own.chain, signer, vote, false, far);
  const tx = parseTransaction(own.sent[1]!);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.maxFeePerGas, 1_250n);
});

test("a receipt of an earlier vote under the same nonce means this one must be sent again", async () => {
  const { chain } = fakeChain({ minedHash: `0x${"cd".repeat(32)}` });
  await assert.rejects(castVote(chain, signer, vote, false, far), (e: unknown) => e instanceof Error && !(e instanceof VoteSent) && /replaced/.test(e.message));
});

test("a failed verification after mining is reported as sent", async () => {
  await assert.rejects(castVote(fakeChain({ verifyFails: true }).chain, signer, vote, false, far), VoteSent);
});

test("the module ABI names the Voter's errors that a simulated vote passes through", () => {
  for (const name of ["EpochFlipInProgress", "EpochStale", "VotedAlready"]) {
    assert.equal(decodeErrorResult({ abi: moduleAbi, data: toFunctionSelector(`${name}()`) }).errorName, name);
  }
});

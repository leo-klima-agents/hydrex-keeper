import {
  encodeFunctionData,
  parseGwei,
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { base } from "viem/chains";
import { immutableAbi, moduleAbi } from "./abi.ts";
import { lower, readMany, voterCall, type Chain, type Client } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import type { Vote } from "./select.ts";

export const RECEIPT_TIMEOUT_MS = 60_000;
const CONGESTED = 0.9; // in a block this full, the builder picks by tip
const TIP_PERCENTILE = 99;
const MAX_TIP = parseGwei("0.1");
const MAX_GAS = 16_777_216n; // per transaction on Base, since its Azul upgrade

/** Failed after the transaction was sent: retrying would send another one. */
export class VoteSent extends Error {}

export type Tx = {
  chainId: number;
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
};

/** The block a vote in the last blocks is for: its timestamp (s), and the conduit's `lastVoted` as read on it. */
type Target = { time: bigint; lastVoted: bigint };

/** `from` signed it; the keeper, unless said otherwise. */
export type Prepared = { tx: Tx; signed?: Hex | undefined; lastVoted?: bigint | undefined; from?: Address | undefined };

/** Who signs a conduit's transactions and where they go; `conduit` is the voter the Voter records. */
export type Sender = { name: string; from: Address; to: Address; abi: Abi; conduit: Address };

/** The Klima conduit's: the keeper calls the module, which calls the conduit. */
export const klimaSender = ({ keeper, module, conduit }: Chain): Sender => ({
  name: "keeper",
  from: keeper,
  to: module,
  abi: moduleAbi,
  conduit,
});

/** The immutable conduit's: the proposer calls it directly. */
export function v2Sender({ v2 }: Chain): Sender {
  if (!v2) throw new Error("no immutable conduit configured");
  return { name: "proposer", from: v2.proposer, to: v2.conduit, abi: immutableAbi, conduit: v2.conduit };
}

export type ModuleCall =
  | { functionName: "vote"; args: readonly [Address[], bigint[]] }
  | {
      functionName: "claimSwapAndDistribute";
      args: readonly [bigint, Address[], Hex[], Address[], Address[], Address[], bigint, bigint];
    };

type LastSent = Tx & { lastVoted?: bigint | undefined; mined?: boolean };

/** By client, then by sender. */
const lastSentBy = new WeakMap<Client, Map<Address, LastSent>>();

function sentBy(client: Client): Map<Address, LastSent> {
  let sent = lastSentBy.get(client);
  if (!sent) lastSentBy.set(client, (sent = new Map()));
  return sent;
}

/**
 * Simulates the sender's vote just after the block it is for, by default the latest, and signs it unless there is no
 * key. The max fee is twice the base fee plus the tip; if either of the last two blocks was congested, the tip rises to
 * the 99th percentile of their tips, up to MAX_TIP.
 */
export async function prepareVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  target?: Target,
  sender: Sender = klimaSender(chain),
): Promise<Prepared> {
  const { tx, cost, balance, tip, congested } = await prepareCall(
    chain,
    { functionName: "vote", args: [vote.pools, vote.weights] },
    { target, sender },
  );
  // A vote before the last blocks must leave enough to vote in them.
  const needed = (target ? 1n : 2n) * cost;
  const { name, from, conduit } = sender;
  if (balance < needed) {
    throw new Error(`fund the ${name}: ${from} has ${balance} wei, needs ${needed}: a vote costs up to ${cost}`);
  }
  const { pools, weights } = vote;
  log.info("vote prepared", { conduit, pools, weights, gas: tx.gas, nonce: tx.nonce, tip, congested });
  return { ...(await signTx(account, tx, dryRun)), lastVoted: target?.lastVoted, from };
}

type CallOptions = { target?: Target | undefined; before?: readonly ModuleCall[]; at?: bigint; sender?: Sender };

/**
 * Builds and simulates the sender's transaction for `call`, after the calls in `before`, which a dry run built but did
 * not send. Throws if it would revert. Costs are in wei, L1 fee included. `queued` is whether another transaction of
 * the sender is pending at its nonce.
 */
export async function prepareCall(
  chain: Chain,
  { functionName, args }: ModuleCall,
  { target, before = [], at, sender = klimaSender(chain) }: CallOptions = {},
) {
  const { client } = chain;
  const { from, to, abi } = sender;
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const toCall = (c: ModuleCall) => ({ account: from, to, abi, ...c }) as const;
  // Votes are simulated just after the latest block, which may already be the one a last-block vote is for. Other
  // votes name that block by number, since a node further ahead would refuse a time before its own latest block.
  // Claims need no time.
  const head = functionName === "vote" && !target ? await client.getBlock() : undefined;
  const time = target?.time ?? head?.timestamp;
  const blockOverrides = time === undefined ? {} : { blockOverrides: { time: time + 1n } };
  const on = head ? { blockNumber: head.number } : at !== undefined ? { blockNumber: at } : {};
  const calls = [...before, { functionName, args } as ModuleCall].map(toCall);
  const [[block], suggested, history, latest, pending, balance, l1Fee] = await allOrFirstFailure([
    client.simulateBlocks({ ...on, blocks: [{ ...blockOverrides, calls: calls as never[] }] }),
    client.estimateMaxPriorityFeePerGas(),
    client.getFeeHistory({ blockCount: 2, rewardPercentiles: [TIP_PERCENTILE] }),
    client.getTransactionCount({ address: from, blockTag: "latest" }),
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    client.getBalance({ address: from, blockTag: "pending" }),
    client.estimateL1Fee({ account: from, to, data }),
  ]);
  const simulated = block!.calls.at(-1)!;
  const what = functionName === "vote" ? "the vote" : "the claim";
  if (simulated.status !== "success") throw simulated.error ?? new Error(`${what} would revert`);
  const baseFee = history.baseFeePerGas.at(-1); // the next block's
  if (baseFee === undefined) throw new Error("no base fee");
  const congested = history.gasUsedRatio.some((ratio) => ratio >= CONGESTED);
  const top = (history.reward ?? []).reduce((a, [reward]) => max(a, reward ?? 0n), 0n);
  const tip = congested ? max(suggested, min(top, MAX_TIP)) : suggested;
  // The confirmed nonce, so that a pending vote is replaced, not queued behind: at a quarter more than the one this
  // process sent, or at twice the fees over one of unknown fees. Once the Voter shows a later vote than the one the sent
  // vote was decided on, or its receipt was seen, that transaction is in a block, whatever the node says.
  const lastSent = sentBy(client).get(lower(from));
  const mined =
    lastSent?.mined === true || (target && lastSent?.lastVoted !== undefined && target.lastVoted > lastSent.lastVoted);
  const nonce = Math.max(latest, mined ? lastSent.nonce + 1 : 0);
  const queued = pending > nonce;
  const own = lastSent?.nonce === nonce ? lastSent : undefined;
  const bump = (fee: bigint, sent?: bigint) =>
    sent !== undefined ? max(fee, (sent * 5n) / 4n) : queued ? fee * 2n : fee;
  const tx = {
    chainId: base.id,
    to,
    data,
    // Refunds and the 63/64 rule make the gas needed exceed the gas used, by up to about a third.
    gas: min((simulated.gasUsed * 3n) / 2n, MAX_GAS),
    maxFeePerGas: bump(2n * baseFee + tip, own?.maxFeePerGas),
    maxPriorityFeePerGas: bump(tip, own?.maxPriorityFeePerGas),
    nonce,
  } satisfies Tx;
  const cost = tx.gas * tx.maxFeePerGas + l1Fee;
  const { gasUsed, logs } = simulated;
  const expectedCost = gasUsed * min(tx.maxFeePerGas, baseFee + tx.maxPriorityFeePerGas) + l1Fee;
  return {
    tx,
    cost,
    expectedCost,
    balance,
    tip,
    congested,
    queued,
    simulated: { gasUsed, logs: logs ?? [] },
  };
}

export async function signTx(account: LocalAccount | undefined, tx: Tx, dryRun: boolean): Promise<Prepared> {
  if (!account) {
    log.warning("signing skipped: no KMS key configured");
    return { tx };
  }
  try {
    return { tx, signed: await account.signTransaction(tx) };
  } catch (error) {
    if (dryRun && error instanceof NoMetadataServer) {
      log.warning("signing skipped: no metadata server", { reason: error.message });
      return { tx };
    }
    throw error;
  }
}

/** Sends a signed transaction to every RPC; resolves with its hash once one accepts it before `until` (ms). */
export async function broadcastTx(
  chain: Chain,
  { tx, signed, lastVoted, from = chain.keeper }: Prepared & { signed: Hex },
  until: number,
): Promise<Hex> {
  if (Date.now() >= until) throw new Error("out of time before sending");
  // Before sending: a send that fails may still have reached a node.
  sentBy(chain.client).set(lower(from), { ...tx, lastVoted });
  return chain.broadcast(signed, until);
}

export function markMined({ client, keeper }: Chain, nonce: number, from: Address = keeper): void {
  const sent = sentBy(client);
  const lastSent = sent.get(lower(from));
  if (lastSent?.nonce === nonce) sent.set(lower(from), { ...lastSent, mined: true });
}

/**
 * Whether the sender's nonce is past `nonce` in the block being built. A vote decided before the one it replaces landed
 * reuses that one's nonce, and nodes then refuse it.
 */
export async function nonceTaken({ client, keeper }: Chain, nonce: number, from: Address = keeper): Promise<boolean> {
  return client.getTransactionCount({ address: from, blockTag: "pending" }).then(
    (next) => next > nonce,
    () => false,
  );
}

/** Prepares and sends the sender's vote; verifies the Voter recorded it, waiting at most until `until` (ms). */
export async function castVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  until: number,
  sender: Sender = klimaSender(chain),
): Promise<void> {
  const prepared = await prepareVote(chain, account, vote, dryRun, undefined, sender);
  const { signed } = prepared;
  if (!signed) return;
  if (dryRun) {
    log.info("dry run: signed, not sent");
    return;
  }
  const hash = await broadcastTx(chain, { ...prepared, signed }, until);
  log.info("vote sent", { hash });
  const timeout = Math.max(1, Math.min(RECEIPT_TIMEOUT_MS, until - Date.now()));
  let receipt;
  try {
    receipt = await chain.client.waitForTransactionReceipt({ hash, timeout, confirmations: 2 });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
      throw new VoteSent(`vote ${hash}: outcome unknown: ${errorMessage(error)}`);
    }
    log.warning("receipt not seen in time; the next pass re-checks the Voter", { hash, timeout });
    return;
  }
  if (receipt.transactionHash !== hash) {
    throw new Error(`vote ${hash} was replaced by ${receipt.transactionHash}; sending again`);
  }
  if (receipt.status !== "success") throw new VoteSent(`vote ${hash} reverted`);
  await verifyVote(chain, vote, hash, receipt.blockNumber, sender.conduit);
}

/** Checks that the Voter recorded `vote` for `conduit` as of block `blockNumber`. */
export async function verifyVote(
  chain: Chain,
  vote: Vote,
  hash: Hex,
  blockNumber: bigint,
  conduit: Address = chain.conduit,
): Promise<void> {
  const calls = [
    ...vote.pools.map((_, i) => voterCall(chain, "poolVote", [conduit, BigInt(i)])),
    ...vote.pools.map((pool) => voterCall(chain, "votes", [conduit, pool])),
  ];
  let recorded: (Address | bigint)[];
  try {
    recorded = await readMany<Address | bigint>(chain.client, calls, { blockNumber });
  } catch (error) {
    throw new VoteSent(`vote ${hash} mined in block ${blockNumber}, verification failed: ${errorMessage(error)}`);
  }
  const pools = recorded.slice(0, vote.pools.length) as Address[];
  if (pools.some((pool, i) => pool.toLowerCase() !== vote.pools[i]!.toLowerCase())) {
    throw new VoteSent(`vote ${hash}: Voter recorded ${pools.join(",")}, expected ${vote.pools.join(",")}`);
  }
  log.info("vote confirmed", { conduit, hash, block: blockNumber, pools, votes: recorded.slice(vote.pools.length) });
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

type Promises<T extends readonly unknown[]> = { [K in keyof T]: Promise<T[K]> };

/** Like Promise.all, but the rejection reported is the earliest in the list, not the earliest in time. */
async function allOrFirstFailure<T extends readonly unknown[]>(promises: Promises<T>): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

import {
  decodeFunctionData,
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
import { lastBlockBefore, lower, readMany, voterCall, WEEK, type Chain, type Client } from "./chain.ts";
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

/** `from` signs it. */
export type Prepared = { tx: Tx; from: Address; signed?: Hex | undefined; lastVoted?: bigint | undefined };

/**
 * Who signs a conduit's transactions and where they go; `conduit` is the voter the Voter records. Anyone may vote for
 * an `open` conduit, so a vote of it on chain need not be the sender's. Its transactions are prepared through `client`.
 */
export type Sender = {
  name: string;
  from: Address;
  to: Address;
  abi: Abi;
  conduit: Address;
  open: boolean;
  client: Client;
};

/** The Klima conduit's: the keeper calls the module, which calls the conduit. Only the keeper votes for it. */
export const klimaSender = ({ client, keeper, module, conduit }: Chain): Sender => ({
  name: "keeper",
  from: keeper,
  to: module,
  abi: moduleAbi,
  conduit,
  open: false,
  client,
});

/** The immutable conduit's: the proposer calls it directly, as anyone may, through a client of its own. */
export function v2Sender({ v2, v2Client }: Chain): Sender {
  if (!v2) throw new Error("no immutable conduit configured");
  const { proposer, conduit } = v2;
  return { name: "proposer", from: proposer, to: conduit, abi: immutableAbi, conduit, open: true, client: v2Client };
}

/** Another sender's vote that may land before ours in the same block. */
export type Rival = { sender: Sender; vote: Vote };

export type ModuleCall =
  | { functionName: "vote"; args: readonly [Address[], bigint[]] }
  | {
      functionName: "claimSwapAndDistribute";
      args: readonly [bigint, Address[], Hex[], Address[], Address[], Address[], bigint, bigint];
    }
  | { functionName: "claim"; args: readonly [bigint, Address[], Address[], Address[]] };

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
 * key; with a `rival`, also after the rival's vote, and fails unless both succeed. The max fee is twice the base fee
 * plus the tip; if either of the last two blocks was congested, the tip rises to the 99th percentile of their tips, up
 * to MAX_TIP.
 */
export async function prepareVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  target?: Target,
  sender: Sender = klimaSender(chain),
  rival?: Rival,
): Promise<Prepared> {
  const { tx, cost, balance, tip, congested } = await prepareCall(chain, voteCall(vote), { target, sender, rival });
  // A vote before the last blocks must leave enough to vote in them.
  const needed = (target ? 1n : 2n) * cost;
  const { name, from, conduit } = sender;
  if (balance < needed) {
    throw new Error(`fund the ${name}: ${from} has ${balance} wei, needs ${needed}: a vote costs up to ${cost}`);
  }
  const { pools, weights } = vote;
  log.info("vote prepared", { conduit, pools, weights, gas: tx.gas, nonce: tx.nonce, tip, congested });
  return { ...(await signTx(account, tx, dryRun, from)), lastVoted: target?.lastVoted };
}

const voteCall = ({ pools, weights }: Vote): ModuleCall => ({ functionName: "vote", args: [pools, weights] });

type CallOptions = {
  target?: Target | undefined;
  before?: readonly ModuleCall[];
  at?: bigint;
  sender?: Sender;
  rival?: Rival | undefined;
};

/**
 * Builds and simulates the sender's transaction for `call`, after the calls in `before`, which a dry run built but did
 * not send, through the sender's client. Throws if it would revert. Costs are in wei, L1 fee included. `queued` is
 * whether another transaction of the sender is pending at its nonce. What was sent is known by the chain's client.
 */
export async function prepareCall(
  chain: Chain,
  { functionName, args }: ModuleCall,
  { target, before = [], at, sender = klimaSender(chain), rival }: CallOptions = {},
) {
  const { from, to, abi, client } = sender;
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const callOf = (s: Sender) => (c: ModuleCall) => ({ account: s.from, to: s.to, abi: s.abi, ...c }) as const;
  // Votes are simulated just after the latest block, which may already be the one a last-block vote is for, but
  // within its epoch: the last block before a flip is a second before it, and the immutable conduit refuses a vote
  // from the next epoch. Other votes name that block by number, since a node further ahead would refuse a time before
  // its own latest block. Claims need no time.
  const head = functionName === "vote" && !target ? await client.getBlock() : undefined;
  const time = target?.time ?? head?.timestamp;
  const blockOverrides =
    time === undefined ? {} : { blockOverrides: { time: min(time + 1n, (time / WEEK + 1n) * WEEK - 1n) } };
  const on = head ? { blockNumber: head.number } : at !== undefined ? { blockNumber: at } : {};
  const calls = [...before, { functionName, args } as ModuleCall].map(callOf(sender));
  const simulate = (prior: readonly unknown[]) =>
    client.simulateBlocks({ ...on, blocks: [{ ...blockOverrides, calls: [...prior, ...calls] as never[] }] });
  const [[block], afterRival, suggested, history, latest, pending, balance, l1Fee] = await allOrFirstFailure([
    simulate([]),
    rival ? simulate([callOf(rival.sender)(voteCall(rival.vote))]) : Promise.resolve(undefined),
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
  const second = afterRival?.[0]?.calls.at(-1);
  if (second && second.status !== "success") {
    const reason = second.error ? errorMessage(second.error) : "no reason given";
    throw new Error(`${what} would revert after the ${rival!.sender.name}'s: ${reason}`);
  }
  const baseFee = history.baseFeePerGas.at(-1); // the next block's
  if (baseFee === undefined) throw new Error("no base fee");
  const congested = history.gasUsedRatio.some((ratio) => ratio >= CONGESTED);
  const top = (history.reward ?? []).reduce((a, [reward]) => max(a, reward ?? 0n), 0n);
  const tip = congested ? max(suggested, min(top, MAX_TIP)) : suggested;
  // The confirmed nonce, so that a pending vote is replaced, not queued behind: at a quarter more than the one this
  // process sent, or at twice the fees over one of unknown fees. Once its receipt was seen, or the Voter shows its votes
  // in force (see `landed` in last.ts), or, for a conduit only the sender votes for, once the Voter shows a later vote
  // than the one the sent vote was decided on, that transaction is in a block, whatever the node says.
  const lastSent = sentBy(chain.client).get(lower(from));
  const later = !sender.open && target && lastSent?.lastVoted !== undefined && target.lastVoted > lastSent.lastVoted;
  const mined = lastSent?.mined === true || later;
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
    gas: min((max(simulated.gasUsed, second?.gasUsed ?? 0n) * 3n) / 2n, MAX_GAS),
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

export async function signTx(
  account: LocalAccount | undefined,
  tx: Tx,
  dryRun: boolean,
  from: Address,
): Promise<Prepared> {
  if (!account) {
    log.warning("signing skipped: no KMS key configured");
    return { tx, from };
  }
  try {
    return { tx, from, signed: await account.signTransaction(tx) };
  } catch (error) {
    if (dryRun && error instanceof NoMetadataServer) {
      log.warning("signing skipped: no metadata server", { reason: error.message });
      return { tx, from };
    }
    throw error;
  }
}

/** Sends a signed transaction to every RPC; resolves with its hash once one accepts it before `until` (ms). */
export async function broadcastTx(
  chain: Chain,
  { tx, signed, lastVoted, from }: Prepared & { signed: Hex },
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

/**
 * Prepares and sends the sender's vote, checked after `rival`'s if any; verifies the Voter recorded it, waiting at most
 * until `until` (ms).
 */
export async function castVote(
  chain: Chain,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  until: number,
  sender: Sender = klimaSender(chain),
  rival?: Rival,
): Promise<void> {
  const prepared = await prepareVote(chain, account, vote, dryRun, undefined, sender, rival);
  const { signed } = prepared;
  const { conduit } = sender;
  if (!signed) return;
  if (dryRun) {
    log.info("dry run: signed, not sent", { conduit });
    return;
  }
  const hash = await broadcastTx(chain, { ...prepared, signed }, until);
  log.info("vote sent", { conduit, hash });
  const timeout = Math.max(1, Math.min(RECEIPT_TIMEOUT_MS, until - Date.now()));
  let receipt;
  try {
    receipt = await chain.client.waitForTransactionReceipt({ hash, timeout, confirmations: 2 });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
      throw new VoteSent(`vote ${hash}: outcome unknown: ${errorMessage(error)}`);
    }
    log.warning("receipt not seen in time; the next pass re-checks the Voter", { conduit, hash, timeout });
    return;
  }
  if (receipt.transactionHash !== hash) {
    throw new Error(`vote ${hash} was replaced by ${receipt.transactionHash}; sending again`);
  }
  markMined(chain, prepared.tx.nonce, sender.from);
  if (receipt.status !== "success") {
    // Anyone may vote for an open conduit, and the Voter takes one vote of it per block: when another vote took the
    // block, the pass decides again, against that vote.
    const taken = sender.open && (await tookBlock(chain, conduit, receipt.blockNumber).catch(() => false));
    if (taken) throw new Error(`vote ${hash} reverted: another vote for ${conduit} was first in its block; again`);
    throw new VoteSent(`vote ${hash} reverted`);
  }
  await verifyVote(chain, vote, hash, receipt.blockNumber, sender.conduit);
}

/** When the Voter last recorded a vote of `conduit`, as of block `blockNumber`. */
export async function lastVotedAt(chain: Chain, conduit: Address, blockNumber: bigint): Promise<bigint> {
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [conduit])], { blockNumber });
  return lastVoted!;
}

/** Whether a vote of `conduit` is recorded in block `blockNumber`. */
async function tookBlock(chain: Chain, conduit: Address, blockNumber: bigint): Promise<boolean> {
  const [{ timestamp }, lastVoted] = await Promise.all([
    chain.client.getBlock({ blockNumber }),
    lastVotedAt(chain, conduit, blockNumber),
  ]);
  return lastVoted === timestamp;
}

/**
 * Whether the vote of the immutable conduit that the Voter recorded at `lastVoted` (s) is the sender's: the conduit
 * accepted a vote the sender proposed in the block at that time, and the Voter takes one vote of a conduit per block.
 */
export async function votedAt({ client }: Chain, { from, conduit }: Sender, lastVoted: bigint): Promise<boolean> {
  const block = await lastBlockBefore(client, lastVoted + 1n);
  const accepted = await client.getContractEvents({
    address: conduit,
    abi: immutableAbi,
    eventName: "VoteAccepted",
    args: { proposer: from },
    fromBlock: block,
    toBlock: block,
  });
  return accepted.length > 0;
}

/**
 * The vote this process sent last for the sender, while it may still land: until its receipt is seen, while a
 * transaction of the sender is pending at its nonce. Unknown counts as pending.
 */
export async function pendingVote(chain: Chain, { from, abi, client }: Sender): Promise<Vote | undefined> {
  const last = sentBy(chain.client).get(lower(from));
  if (!last || last.mined) return undefined;
  const { functionName, args } = decodeFunctionData({ abi, data: last.data });
  if (functionName !== "vote") return undefined;
  const pending = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: "latest" }),
    client.getTransactionCount({ address: from, blockTag: "pending" }),
  ]).then(
    ([latest, next]) => latest <= last.nonce && last.nonce < next,
    () => true,
  );
  const [pools, weights] = args as readonly [readonly Address[], readonly bigint[]];
  return pending ? { pools: [...pools], weights: [...weights] } : undefined;
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

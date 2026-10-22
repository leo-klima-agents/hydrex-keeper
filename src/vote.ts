import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
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
const CONGESTED = 0.9; // in blocks this full, the builder orders by tip
const TIP_PERCENTILE = 99;
const MAX_TIP = parseGwei("0.1");
const MAX_GAS = 16_777_216n; // Base's gas limit per transaction since its Azul upgrade

/** The vote was already sent, so retrying would send a second one. */
export class VoteSent extends Error {}

export type Tx = {
  chainId: number;
  to: Address;
  data: Hex;
  value?: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
};

/** The block a last-block vote is for: its timestamp in seconds, and the conduit's `lastVoted` read on it. */
type Target = { time: bigint; lastVoted: bigint };

export type Prepared = { tx: Tx; from: Address; signed?: Hex | undefined; lastVoted?: bigint | undefined };

/**
 * `conduit` is the address the Voter records votes for. Anyone can vote for an `open` conduit, so a vote on chain may
 * not be the sender's.
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

export const klimaSender = ({ client, keeper, module, conduit }: Chain): Sender => ({
  name: "keeper",
  from: keeper,
  to: module,
  abi: moduleAbi,
  conduit,
  open: false,
  client,
});

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

/** Without `abi`, a plain transfer of ETH to `to`. */
export type TxCall = { to: Address; abi?: Abi; functionName?: string; args?: readonly unknown[]; value?: bigint };

export type From = { from: Address; client: Client };

type LastSent = Tx & { lastVoted?: bigint | undefined; mined?: boolean };

const lastSentBy = new WeakMap<Client, Map<Address, LastSent>>();

function sentBy(client: Client): Map<Address, LastSent> {
  let sent = lastSentBy.get(client);
  if (!sent) lastSentBy.set(client, (sent = new Map()));
  return sent;
}

/** With a `rival`, the vote must also succeed after the rival's. */
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
  // A vote before the last blocks must leave enough ETH to vote again in them.
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

export async function prepareCall(
  chain: Chain,
  call: ModuleCall,
  { target, before = [], at, sender = klimaSender(chain), rival }: CallOptions = {},
) {
  // Votes are simulated just after the latest block, at a time kept inside the epoch. The latest block may already be
  // the one a last-block vote is for, that block is one second before the flip, and the immutable conduit refuses votes
  // from the next epoch. Votes without a target also name the latest block by number, because a node further ahead
  // would refuse a time before its own latest block. Claims need no time.
  const head = call.functionName === "vote" && !target ? await sender.client.getBlock() : undefined;
  const time = target?.time ?? head?.timestamp;
  // For a conduit only the sender votes for, a `lastVoted` newer than the one our last vote was decided on means that
  // vote is in a block, whatever the node says.
  const lastSent = sentBy(chain.client).get(lower(sender.from));
  const later =
    !sender.open && target !== undefined && lastSent?.lastVoted !== undefined && target.lastVoted > lastSent.lastVoted;
  return prepareTx(chain, sender, txCallOf(sender, call), {
    what: call.functionName === "vote" ? "the vote" : "the claim",
    before: before.map((c) => txCallOf(sender, c)),
    blockNumber: head?.number ?? at,
    time: time === undefined ? undefined : min(time + 1n, (time / WEEK + 1n) * WEEK - 1n),
    rival: rival && {
      name: rival.sender.name,
      from: rival.sender.from,
      calls: [txCallOf(rival.sender, voteCall(rival.vote))],
    },
    landed: later,
  });
}

const txCallOf = ({ to, abi }: Sender, { functionName, args }: ModuleCall): TxCall => ({ to, abi, functionName, args });

type TxOptions = {
  what: string;
  /** Calls to simulate first: those a dry run built but did not send. */
  before?: readonly TxCall[];
  blockNumber?: bigint | undefined;
  time?: bigint | undefined;
  /** Another sender's calls that may come first in the block. The transaction must succeed after them too. */
  rival?: { name: string; from: Address; calls: readonly TxCall[] } | undefined;
  /** Whether the sender's last transaction is known to be in a block. */
  landed?: boolean;
};

const dataOf = ({ abi, functionName, args }: TxCall): Hex =>
  abi ? encodeFunctionData({ abi, functionName, args } as never) : "0x";

// Decoded, so that a revert names its error.
const simulatedAs =
  (account: Address) =>
  ({ to, abi, functionName, args, value }: TxCall) => ({
    account,
    to,
    ...(abi ? { abi, functionName, args } : {}),
    ...(value ? { value } : {}),
  });

/**
 * Throws if the transaction would revert. The max fee is twice the base fee plus the tip. If either of the last two
 * blocks was congested, the tip rises to the 99th percentile of their tips, up to MAX_TIP. Costs are in wei, include
 * the L1 fee and leave out the value sent. `queued` means another transaction of the sender is pending at its nonce.
 */
export async function prepareTx(chain: Chain, { from, client }: From, call: TxCall, options: TxOptions) {
  const { what, before = [], blockNumber, time, rival, landed = false } = options;
  const { to, value } = call;
  const data = dataOf(call);
  const on = blockNumber === undefined ? {} : { blockNumber };
  const blockOverrides = time === undefined ? {} : { blockOverrides: { time } };
  const calls = [...before, call].map(simulatedAs(from));
  const simulate = (prior: readonly unknown[]) =>
    client.simulateBlocks({ ...on, blocks: [{ ...blockOverrides, calls: [...prior, ...calls] as never[] }] });
  const [[block], afterRival, suggested, history, latest, pending, balance, l1Fee] = await allOrFirstFailure([
    simulate([]),
    rival ? simulate(rival.calls.map(simulatedAs(rival.from))) : Promise.resolve(undefined),
    client.estimateMaxPriorityFeePerGas(),
    client.getFeeHistory({ blockCount: 2, rewardPercentiles: [TIP_PERCENTILE] }),
    client.getTransactionCount({ address: from, blockTag: "latest" }),
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    client.getBalance({ address: from, blockTag: "pending" }),
    client.estimateL1Fee({ account: from, to, data, ...(value ? { value } : {}) }),
  ]);
  const simulated = block!.calls.at(-1)!;
  if (simulated.status !== "success") throw simulated.error ?? new Error(`${what} would revert`);
  const second = afterRival?.[0]?.calls.at(-1);
  if (second && second.status !== "success") {
    const reason = second.error ? errorMessage(second.error) : "no reason given";
    throw new Error(`${what} would revert after the ${rival!.name}'s: ${reason}`);
  }
  const baseFee = history.baseFeePerGas.at(-1); // the next block's
  if (baseFee === undefined) throw new Error("no base fee");
  const congested = history.gasUsedRatio.some((ratio) => ratio >= CONGESTED);
  const top = (history.reward ?? []).reduce((a, [reward]) => max(a, reward ?? 0n), 0n);
  const tip = congested ? max(suggested, min(top, MAX_TIP)) : suggested;
  // The confirmed nonce, so that a pending transaction is replaced rather than queued behind. A replacement pays a
  // quarter more than the one this process sent, or twice the fees when the pending one's fees are unknown. The last
  // transaction counts as mined, whatever the node says, once its receipt was seen, once the Voter shows its votes (see
  // `landed` in last.ts), or when the caller knows it is in a block.
  const lastSent = sentBy(chain.client).get(lower(from));
  const mined = lastSent?.mined === true || landed;
  const nonce = Math.max(latest, mined && lastSent ? lastSent.nonce + 1 : 0);
  const queued = pending > nonce;
  const own = lastSent?.nonce === nonce ? lastSent : undefined;
  const bump = (fee: bigint, sent?: bigint) =>
    sent !== undefined ? max(fee, (sent * 5n) / 4n) : queued ? fee * 2n : fee;
  const tx = {
    chainId: base.id,
    to,
    data,
    ...(value ? { value } : {}),
    // Refunds and the 63/64 rule mean a transaction can need about a third more gas than it uses.
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

export async function broadcastTx(
  chain: Chain,
  { tx, signed, lastVoted, from }: Prepared & { signed: Hex },
  until: number,
): Promise<Hex> {
  if (Date.now() >= until) throw new Error("out of time before sending");
  // Recorded before sending, because a send that fails may still have reached a node.
  sentBy(chain.client).set(lower(from), { ...tx, lastVoted });
  return chain.broadcast(signed, until);
}

export function markMined({ client, keeper }: Chain, nonce: number, from: Address = keeper): void {
  const sent = sentBy(client);
  const lastSent = sent.get(lower(from));
  if (lastSent?.nonce === nonce) sent.set(lower(from), { ...lastSent, mined: true });
}

/** The transaction's outcome is unknown. It may still land, so sending another could do the same thing twice. */
export class Unconfirmed extends Error {}

/** Throws Unconfirmed if the receipt isn't seen in time or another transaction replaced this one. */
export async function confirmTx(chain: Chain, from: Address, hash: Hex, nonce: number, what: string) {
  let receipt;
  try {
    receipt = await chain.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, confirmations: 2 });
  } catch (error) {
    throw new Unconfirmed(`${what} ${hash}: outcome unknown: ${errorMessage(error)}`);
  }
  if (receipt.transactionHash !== hash)
    throw new Unconfirmed(`${what} ${hash} was replaced by ${receipt.transactionHash}`);
  markMined(chain, nonce, from);
  if (receipt.status !== "success") throw new Error(`${what} ${hash} reverted`);
  return receipt;
}

/**
 * Whether `nonce` is already used in the pending block. A vote decided before the one it replaces landed would reuse
 * that nonce, and nodes refuse it.
 */
export async function nonceTaken({ client, keeper }: Chain, nonce: number, from: Address = keeper): Promise<boolean> {
  return client.getTransactionCount({ address: from, blockTag: "pending" }).then(
    (next) => next > nonce,
    () => false,
  );
}

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
    // The Voter takes one vote per block for a conduit, and anyone can vote for an open one. When another vote took the
    // block, the pass decides again against that vote.
    const taken = sender.open && (await tookBlock(chain, conduit, receipt.blockNumber).catch(() => false));
    if (taken) throw new Error(`vote ${hash} reverted: another vote for ${conduit} was first in its block; again`);
    throw new VoteSent(`vote ${hash} reverted`);
  }
  await verifyVote(chain, vote, hash, receipt.blockNumber, sender.conduit);
}

export async function lastVotedAt(chain: Chain, conduit: Address, blockNumber: bigint): Promise<bigint> {
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [conduit])], { blockNumber });
  return lastVoted!;
}

async function tookBlock(chain: Chain, conduit: Address, blockNumber: bigint): Promise<boolean> {
  const [{ timestamp }, lastVoted] = await Promise.all([
    chain.client.getBlock({ blockNumber }),
    lastVotedAt(chain, conduit, blockNumber),
  ]);
  return lastVoted === timestamp;
}

/**
 * Whether the immutable conduit's vote recorded at `lastVoted` (s) is the sender's. The Voter takes one vote per
 * conduit per block, so it is if the conduit accepted a vote the sender proposed in that block.
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
 * The vote this process sent last for the sender, while it may still land: until its receipt is seen, and while a
 * transaction of the sender is pending at its nonce. If that can't be read, it counts as pending.
 */
export async function pendingVote(chain: Chain, { from, to, abi, client }: Sender): Promise<Vote | undefined> {
  const last = sentBy(chain.client).get(lower(from));
  // The last transaction may have gone elsewhere, like a top-up's. Then it isn't a vote, and `abi` can't decode it.
  if (!last || last.mined || !isAddressEqual(last.to, to)) return undefined;
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

/** Like Promise.all, but the rejection reported is the first in the list, not the first in time. */
async function allOrFirstFailure<T extends readonly unknown[]>(promises: Promises<T>): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

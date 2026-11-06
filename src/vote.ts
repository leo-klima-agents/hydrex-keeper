import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseGwei,
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { base } from "viem/chains";
import type { immutableAbi } from "./abi.ts";
import { blocksBetween, lower, readMany, voterCall, WEEK, type Chain, type Client, type Conduit } from "./chain.ts";
import { NoMetadataServer } from "./kms.ts";
import { errorMessage, log } from "./log.ts";
import type { Vote } from "./select.ts";

export const RECEIPT_TIMEOUT_MS = 60_000;
const CONGESTED = 0.9; // in blocks this full, the builder orders by tip
const TIP_PERCENTILE = 99;
const MAX_TIP = parseGwei("0.1");
const FEE_BLOCKS = 20; // four seconds of blocks
const MAX_GAS = 16_777_216n; // Base's gas limit per transaction

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

/** The other conduit's vote, which may land before ours in the same block. */
export type Rival = { conduit: Conduit; vote: Vote };

/** What a conduit's key sends: to the Klima conduit's Safe module, or to the immutable conduit itself. */
export type ConduitCall =
  | { functionName: "vote"; args: readonly [Address[], bigint[]] }
  | {
      functionName: "claimSwapAndDistribute";
      args: readonly [bigint, Address[], Hex[], Address[], Address[], Address[], bigint, bigint];
    }
  | { functionName: "claim"; args: readonly [bigint, Address[], Address[], Address[]] };

/** Without `abi`, a plain transfer of ETH to `to`. */
export type TxCall = { to: Address; abi?: Abi; functionName?: string; args?: readonly unknown[]; value?: bigint };

export type From = { from: Address; client: Client };

/**
 * The last transaction this process sent from an address. `hashes` are those of every transaction it sent at that
 * nonce, any of which may land, and `underpriced` means nodes refused the last one because a transaction they hold at
 * that nonce pays as much: one this process doesn't know, such as one an earlier attempt sent.
 */
type LastSent = Tx & { hashes: Hex[]; lastVoted?: bigint | undefined; mined?: boolean; underpriced?: boolean };

const lastSentBy = new WeakMap<Client, Map<Address, LastSent>>();

function sentBy(client: Client): Map<Address, LastSent> {
  let sent = lastSentBy.get(client);
  if (!sent) lastSentBy.set(client, (sent = new Map()));
  return sent;
}

type VoteOptions = { target?: Target | undefined; rival?: Rival | undefined; fees?: Fees | undefined };

/** With a `rival`, the vote must also succeed after the rival's. Without `fees`, they are read. */
export async function prepareVote(
  chain: Chain,
  conduit: Conduit,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  { target, rival, fees }: VoteOptions = {},
): Promise<Prepared> {
  const prepared = await prepareCall(chain, conduit, voteCall(vote), { target, rival, fees });
  const { tx, cost, balance, tip, congested } = prepared;
  // A vote before the last blocks must leave enough ETH to vote again in them.
  const needed = (target ? 1n : 2n) * cost;
  const { label, role, from } = conduit;
  if (balance < needed) {
    throw new Error(`fund ${label}'s ${role}: ${from} has ${balance} wei, needs ${needed}: a vote costs up to ${cost}`);
  }
  const { pools, weights } = vote;
  const fields = { conduit: conduit.address, pools, weights, gas: tx.gas, nonce: tx.nonce, tip, congested };
  log.info("vote prepared", fields);
  return { ...(await signTx(account, tx, dryRun, from)), lastVoted: target?.lastVoted };
}

const voteCall = ({ pools, weights }: Vote): ConduitCall => ({ functionName: "vote", args: [pools, weights] });

type CallOptions = {
  target?: Target | undefined;
  before?: readonly ConduitCall[];
  at?: bigint;
  rival?: Rival | undefined;
  fees?: Fees | undefined;
};

export async function prepareCall(
  chain: Chain,
  sender: Conduit,
  call: ConduitCall,
  { target, before = [], at, rival, fees }: CallOptions = {},
) {
  // Votes are simulated just after the latest block, at a time kept inside the epoch. The latest block may already be
  // in the second a last-block vote is for, the last one before the flip, and the immutable conduit refuses votes from
  // the next epoch. Nodes accept the latest block's own second. Votes without a target also name the latest block by
  // number, because a node further ahead would refuse a time before its own latest block. Claims need no time.
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
      name: rival.conduit.label,
      from: rival.conduit.from,
      calls: [txCallOf(rival.conduit, voteCall(rival.vote))],
    },
    landed: later,
    fees,
  });
}

const txCallOf = ({ to, abi }: Conduit, { functionName, args }: ConduitCall): TxCall => ({
  to,
  abi,
  functionName,
  args,
});

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
  /** Read with `readFees` if not given. */
  fees?: Fees | undefined;
};

/** The next block's base fee, and the tip to pay: `congested` when any of the last FEE_BLOCKS blocks was. */
export type Fees = { baseFee: bigint; tip: bigint; congested: boolean };

/**
 * The tip is the suggested one, or if any of the last FEE_BLOCKS blocks was congested, the 99th percentile of their
 * tips, up to MAX_TIP.
 */
export async function readFees(client: Client): Promise<Fees> {
  const [suggested, history] = await Promise.all([
    client.estimateMaxPriorityFeePerGas(),
    client.getFeeHistory({ blockCount: FEE_BLOCKS, rewardPercentiles: [TIP_PERCENTILE] }),
  ]);
  const baseFee = history.baseFeePerGas.at(-1); // the next block's
  if (baseFee === undefined) throw new Error("no base fee");
  const congested = history.gasUsedRatio.some((ratio) => ratio >= CONGESTED);
  const top = (history.reward ?? []).reduce((a, [reward]) => max(a, reward ?? 0n), 0n);
  return { baseFee, tip: congested ? max(suggested, min(top, MAX_TIP)) : suggested, congested };
}

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
 * Throws if the transaction would revert. The max fee is twice the base fee plus the tip (see `readFees`). Costs are in
 * wei, include the L1 fee and leave out the value sent.
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
  const [[block], afterRival, fees, latest, balance, l1Fee] = await allOrFirstFailure([
    simulate([]),
    rival ? simulate(rival.calls.map(simulatedAs(rival.from))) : Promise.resolve(undefined),
    options.fees ? Promise.resolve(options.fees) : readFees(client),
    client.getTransactionCount({ address: from }),
    client.getBalance({ address: from }),
    client.estimateL1Fee({ account: from, to, data, ...(value ? { value } : {}) }),
  ]);
  const simulated = block!.calls.at(-1)!;
  if (simulated.status !== "success") throw simulated.error ?? new Error(`${what} would revert`);
  const second = afterRival?.[0]?.calls.at(-1);
  if (second && second.status !== "success") {
    const reason = second.error ? errorMessage(second.error) : "no reason given";
    throw new Error(`${what} would revert after ${rival!.name}'s vote: ${reason}`);
  }
  const { baseFee, tip, congested } = fees;
  // The confirmed nonce, so that a transaction this process sent and hasn't seen in a block is replaced rather than
  // queued behind, at a quarter more than its fees, or twice them if nodes refused it as underpriced. The last
  // transaction counts as mined, whatever the node says, once its receipt was seen, once the Voter shows its votes (see
  // `landed` in last.ts), or when the caller knows it is in a block.
  const lastSent = sentBy(chain.client).get(lower(from));
  const mined = lastSent?.mined === true || landed;
  const nonce = Math.max(latest, mined && lastSent ? lastSent.nonce + 1 : 0);
  const own = lastSent?.nonce === nonce ? lastSent : undefined;
  const bump = (fee: bigint, sent?: bigint) =>
    sent === undefined ? fee : max(fee, own?.underpriced ? sent * 2n : (sent * 5n) / 4n);
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
  const sent = sentBy(chain.client);
  const last = sent.get(lower(from));
  const hash = keccak256(signed);
  const earlier = last && !last.mined && last.nonce === tx.nonce ? last.hashes : [];
  sent.set(lower(from), { ...tx, hashes: [...earlier, hash], lastVoted });
  try {
    return await chain.broadcast(signed, until);
  } catch (error) {
    const record = sent.get(lower(from));
    if (/underpriced/i.test(errorMessage(error)) && record?.hashes.at(-1) === hash) {
      sent.set(lower(from), { ...record, underpriced: true });
    }
    throw error;
  }
}

/**
 * Whether a transaction this process sent from `from` at `nonce`, and hasn't seen in a block, may still land: a node
 * holds it. Undefined when no node answers. A claim or a top-up must not replace one, since it may be a vote.
 */
export async function heldAt(chain: Chain, from: Address, nonce: number): Promise<boolean | undefined> {
  const last = sentBy(chain.client).get(lower(from));
  if (!last || last.mined || last.nonce !== nonce) return false;
  return chain.known(last.hashes);
}

export function markMined({ client }: Chain, nonce: number, from: Address): void {
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
 * Whether `nonce` is already used in a block, or held by a node for a transaction this process sent before. A vote
 * decided before the one it replaces landed would reuse that nonce, and a node refuses it, as it refuses one that pays
 * too little more than a transaction it holds.
 */
export async function nonceTaken(chain: Chain, nonce: number, from: Address): Promise<boolean> {
  const [next, held] = await Promise.all([
    chain.client.getTransactionCount({ address: from }).catch(() => undefined),
    heldAt(chain, from, nonce),
  ]);
  return (next !== undefined && next > nonce) || held === true;
}

export async function castVote(
  chain: Chain,
  sender: Conduit,
  account: LocalAccount | undefined,
  vote: Vote,
  dryRun: boolean,
  until: number,
  rival?: Rival,
): Promise<void> {
  const prepared = await prepareVote(chain, sender, account, vote, dryRun, { rival });
  const { signed } = prepared;
  const conduit = sender.address;
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
    // The Voter takes one vote per second for a conduit, and anyone can vote for an open one. When another vote took
    // the second, the pass decides again against that vote.
    const taken = sender.open && (await tookSecond(chain, conduit, receipt.blockNumber).catch(() => false));
    if (taken) throw new Error(`vote ${hash} reverted: another vote for ${conduit} was first in its second; again`);
    throw new VoteSent(`vote ${hash} reverted`);
  }
  await verifyVote(chain, vote, hash, receipt.blockNumber, conduit);
}

export async function lastVotedAt(chain: Chain, conduit: Address, blockNumber: bigint): Promise<bigint> {
  const [lastVoted] = await readMany<bigint>(chain.client, [voterCall(chain, "lastVoted", [conduit])], { blockNumber });
  return lastVoted!;
}

async function tookSecond(chain: Chain, conduit: Address, blockNumber: bigint): Promise<boolean> {
  const [{ timestamp }, lastVoted] = await Promise.all([
    chain.client.getBlock({ blockNumber }),
    lastVotedAt(chain, conduit, blockNumber),
  ]);
  return lastVoted === timestamp;
}

/**
 * Whether an open conduit's vote recorded at `lastVoted` (s) is its key's. The Voter takes one vote per conduit per
 * second, so it is if the conduit accepted a vote the key proposed in one of that second's blocks.
 */
export async function votedAt({ client }: Chain, { from, address, abi }: Conduit, lastVoted: bigint): Promise<boolean> {
  const [first, last] = await blocksBetween(client, lastVoted, lastVoted + 1n);
  const accepted = await client.getContractEvents({
    address,
    abi: abi as typeof immutableAbi,
    eventName: "VoteAccepted",
    args: { proposer: from },
    fromBlock: first,
    toBlock: last,
  });
  return accepted.length > 0;
}

/**
 * The vote this process sent last for the conduit, while it may still land: until its receipt is seen, while no block
 * holds a transaction at its nonce, and while a node still has it. A nonce that can't be read counts as unused, and
 * nodes that don't answer as holding the vote.
 */
export async function pendingVote(chain: Chain, { from, to, abi, client }: Conduit): Promise<Vote | undefined> {
  const last = sentBy(chain.client).get(lower(from));
  // The last transaction may have gone elsewhere, like a top-up's. Then it isn't a vote, and `abi` can't decode it.
  if (!last || last.mined || !isAddressEqual(last.to, to)) return undefined;
  const { functionName, args } = decodeFunctionData({ abi, data: last.data });
  if (functionName !== "vote") return undefined;
  const [free, held] = await Promise.all([
    client.getTransactionCount({ address: from }).then(
      (latest) => latest <= last.nonce,
      () => true,
    ),
    heldAt(chain, from, last.nonce),
  ]);
  const landing = free && held !== false;
  const [pools, weights] = args as readonly [readonly Address[], readonly bigint[]];
  return landing ? { pools: [...pools], weights: [...weights] } : undefined;
}

export async function verifyVote(
  chain: Chain,
  vote: Vote,
  hash: Hex,
  blockNumber: bigint,
  conduit: Address,
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

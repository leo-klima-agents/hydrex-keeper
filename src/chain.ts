import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTransport,
  fallback,
  http,
  isAddressEqual,
  keccak256,
  shouldThrow,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi, voterAbi } from "./abi.ts";
import { errorMessage, log } from "./log.ts";

export const WEEK = 7n * 24n * 60n * 60n;
export const CHUNK = 1_000; // calls per eth_call: publicnode takes 1,132 and rejects 2,264
export const HEDGE_DELAY_MS = 250; // a healthy provider answers a pass's read in about 125 ms
const TIMEOUT_MS = 5_000;
const BULK_TIMEOUT_MS = 30_000;
const BLOCK_SECONDS = 2n; // on Base

export const now = () => BigInt(Math.floor(Date.now() / 1000));

export const lower = (address: Address) => address.toLowerCase() as Address;

/** The host of an RPC URL, for logs: provider URLs carry their API key. */
export const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : "invalid URL");

// mainnet.base.org rejects JSON-RPC batches of more than 10 calls.
const transportOf = (url: string) => http(url, { batch: { batchSize: 10 }, timeout: TIMEOUT_MS });

/**
 * Asks the URLs in order, hedged: when one has not answered within HEDGE_DELAY_MS, or has failed, the next is asked
 * too, and the first answer wins. A URL that missed the delay is asked together with the next until it answers within
 * it again, so a hung primary costs the delay once, not on every call. A revert is returned as is. No retries:
 * main.ts retries whole passes.
 */
export function hedged(rpcUrls: string[]): Transport {
  return ({ chain }) => {
    const children = rpcUrls.map((url) => transportOf(url)({ chain, retryCount: 0 }));
    const slow = new Set<number>();
    const request = ({ method, params }: { method: string; params?: unknown }) =>
      new Promise((resolve, reject) => {
        const errors: unknown[] = [];
        let started = 0;
        let settled = 0;
        let done = false;
        const ask = () => {
          if (done || started === children.length) return;
          const i = started++;
          const t0 = Date.now();
          const hedge = setTimeout(() => (slow.add(i), ask()), slow.has(i) ? 0 : HEDGE_DELAY_MS);
          children[i]!.request({ method, params }).then(
            (result) => {
              clearTimeout(hedge);
              if (Date.now() - t0 < HEDGE_DELAY_MS) slow.delete(i);
              if (!done) ((done = true), resolve(result));
            },
            (error: Error) => {
              clearTimeout(hedge);
              errors[i] = error;
              settled++;
              if (done) return;
              if (shouldThrow(error)) return ((done = true), reject(error));
              if (i === started - 1) ask();
              if (settled === started && started === children.length) ((done = true), reject(errors[0]));
            },
          );
        };
        ask();
      });
    return createTransport({ key: "hedged", name: "Hedged", type: "hedged", request: request as never, retryCount: 0 });
  };
}

/**
 * Sends a signed transaction to every URL at once, so that inclusion does not depend on one node, and resolves with its
 * hash once one accepts it or already has it; the other answers are logged. Rejects if none does before `until` (ms).
 */
export function broadcaster(rpcUrls: string[]) {
  // Unbatched, so that a vote does not wait for reads sent to the same URL.
  const nodes = rpcUrls.map((url) => ({ host: hostOf(url), transport: http(url) }));
  return (signed: Hex, until: number): Promise<Hex> => {
    const hash = keccak256(signed);
    const timeout = Math.max(1, Math.min(TIMEOUT_MS, until - Date.now()));
    const sends = nodes.map(async ({ host, transport }) => {
      try {
        const node = transport({ chain: base, retryCount: 0, timeout });
        await node.request({ method: "eth_sendRawTransaction", params: [signed] });
      } catch (error) {
        const message = errorMessage(error);
        if (!/already known|known transaction|already imported/i.test(message)) throw new Error(`${host}: ${message}`);
      }
      return host;
    });
    const reasons = (errors: unknown[]) => errors.map((e) => (e as Error).message);
    void Promise.allSettled(sends).then((results) =>
      log.info("broadcast", {
        hash,
        accepted: results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
        rejected: reasons(results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))),
      }),
    );
    return Promise.any(sends).then(
      () => hash,
      (error: AggregateError) => {
        throw new Error(`no RPC accepted the transaction: ${reasons(error.errors).join("; ")}`);
      },
    );
  };
}

function makeClient(transport: Transport) {
  const client = createPublicClient({ chain: base, transport, pollingInterval: 1_000 });
  return client.extend(publicActionsL2());
}

export type Client = ReturnType<typeof makeClient>;

const bulkTransport = (rpcUrls: string[]) =>
  fallback(
    rpcUrls.map((url) => http(url, { batch: false, timeout: BULK_TIMEOUT_MS, retryCount: 0 })),
    { retryCount: 0 },
  );

export type Chain = {
  client: Client;
  /** For heavy reads, which take seconds: they go to one URL at a time instead of being hedged. */
  bulk: Client;
  /**
   * Like `client`, with batches and hedging of its own, for the immutable conduit's votes: the calls one client sends
   * at once share a JSON-RPC batch, which answers when its slowest call does.
   */
  v2Client: Client;
  broadcast: ReturnType<typeof broadcaster>;
  module: Address;
  conduit: Address;
  keeper: Address;
  voter: Address;
  ve: Address;
  /** The immutable conduit the job also votes for, if any; see connectV2. */
  v2?: V2 | undefined;
};

/** The immutable conduit, the address that signs its votes, and the tokens it prices with Chainlink. */
export type V2 = { conduit: Address; proposer: Address; priced: Address[] };

export async function connect(module: Address, rpcUrls: string[]): Promise<Chain> {
  const client = makeClient(hedged(rpcUrls));
  const [conduit, keeper] = (await readMany<Address>(client, [
    call(module, moduleAbi, "CONDUIT"),
    call(module, moduleAbi, "KEEPER"),
  ])) as [Address, Address];
  const [voter, ve] = (await readMany<Address>(client, [
    call(conduit, conduitAbi, "voter"),
    call(conduit, conduitAbi, "veToken"),
  ])) as [Address, Address];
  const bulk = makeClient(bulkTransport(rpcUrls));
  const v2Client = makeClient(hedged(rpcUrls));
  return { client, bulk, v2Client, broadcast: broadcaster(rpcUrls), module, conduit, keeper, voter, ve };
}

export type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

export function call(
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Call {
  return { address, abi, functionName, args };
}

export const voterCall = ({ voter }: Chain, functionName: string, args?: readonly unknown[]) =>
  call(voter, voterAbi, functionName, args);

type ReadOptions = {
  blockNumber?: bigint;
  blockTag?: "pending" | undefined;
  chunk?: number;
  concurrency?: number;
};

/**
 * One eth_call per CHUNK calls, sent in parallel, so that a read comes from one block and public nodes see few
 * requests. Every call must succeed.
 */
export async function readMany<T>(client: Client, calls: readonly Call[], options: ReadOptions = {}): Promise<T[]> {
  return (await multicall(client, calls, false, options)) as T[];
}

/** Like readMany, but a call that reverts gives undefined. Other errors still throw. */
export async function readEach<T>(
  client: Client,
  calls: readonly Call[],
  options: ReadOptions = {},
): Promise<(T | undefined)[]> {
  const settled = (await multicall(client, calls, true, options)) as { status: string; result?: T; error?: unknown }[];
  return settled.map(({ status, result, error }, i) => {
    if (status === "success") return result;
    if (reverted(error, calls[i]!)) return undefined;
    throw error;
  });
}

/**
 * Whether `call` itself reverted. When a node fails, every call in the multicall fails too, with what looks like a
 * revert, but of the multicall contract.
 */
const reverted = (error: unknown, { address }: Call) =>
  error instanceof ContractFunctionExecutionError &&
  error.contractAddress !== undefined &&
  isAddressEqual(error.contractAddress, address) &&
  error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;

/**
 * The number of the last block before `time` (s): estimated from the latest block, then checked with the block after
 * it. If the estimate is off, as when the block time changes, steps that double from it bracket the block, and halving
 * them finds it.
 */
export async function lastBlockBefore(client: Client, time: bigint): Promise<bigint> {
  const head = await client.getBlock();
  if (head.timestamp < time) throw new Error(`the latest block, at ${head.timestamp}, is not past ${time} yet`);
  const before = async (blockNumber: bigint) => (await client.getBlock({ blockNumber })).timestamp < time;
  const estimate = head.number - (head.timestamp - time) / BLOCK_SECONDS - 1n;
  // `lo` is before `time`, and `hi` is not: the head is not.
  let lo = estimate < 0n ? 0n : estimate < head.number ? estimate : head.number - 1n;
  let hi = lo + 1n;
  const [loBefore, hiBefore] = await Promise.all([before(lo), before(hi)]);
  if (!loBefore) {
    for (let step = 1n; ; step *= 2n) {
      hi = lo;
      lo = hi > step ? hi - step : 0n;
      if (await before(lo)) break;
      if (lo === 0n) throw new Error(`no block before ${time}`);
    }
  } else if (hiBefore) {
    for (let step = 1n; ; step *= 2n) {
      lo = hi;
      hi = lo + step < head.number ? lo + step : head.number;
      if (!(await before(hi))) break;
    }
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await before(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function multicall(
  client: Client,
  calls: readonly Call[],
  allowFailure: boolean,
  { blockNumber, blockTag, chunk = CHUNK, concurrency = Infinity }: ReadOptions,
): Promise<unknown[]> {
  const at = blockNumber !== undefined ? { blockNumber } : blockTag ? { blockTag } : {};
  const chunks = Array.from({ length: Math.ceil(calls.length / chunk) }, (_, i) =>
    calls.slice(i * chunk, (i + 1) * chunk),
  );
  const results: unknown[][] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < chunks.length; i = next++) {
      results[i] = await client.multicall({ contracts: chunks[i] as never, allowFailure, batchSize: 0, ...at });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return results.flat();
}

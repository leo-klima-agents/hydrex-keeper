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
export const CHUNK = 1_000; // calls per eth_call. publicnode accepts 1,132 and rejects 2,264.
export const HEDGE_DELAY_MS = 250; // a healthy node answers a read in about 125 ms
const TIMEOUT_MS = 5_000;
const BULK_TIMEOUT_MS = 30_000;
export const BLOCK_MS = 200; // Base's block time

export const WETH: Address = "0x4200000000000000000000000000000000000006";

export const now = () => BigInt(Math.floor(Date.now() / 1000));

/**
 * A block's time in ms. Five blocks share each second of `timestamp`, and RPCs give the full time as `timestampMs`,
 * which viem passes on as it came.
 */
export function msOf(block: object): number | undefined {
  const { timestampMs } = block as { timestampMs?: unknown };
  if (typeof timestampMs !== "string") return undefined;
  try {
    return Number(BigInt(timestampMs));
  } catch {
    return undefined;
  }
}

/** A block's time in ms, or its second's when it has no `timestampMs`. */
export const msAt = (block: { timestamp: bigint }) => msOf(block) ?? Number(block.timestamp) * 1000;

export const lower = (address: Address) => address.toLowerCase() as Address;

// Logs only show the host, because provider URLs contain API keys.
export const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : "invalid URL");

// mainnet.base.org rejects JSON-RPC batches of more than 10 calls.
const transportOf = (url: string) => http(url, { batch: { batchSize: 10 }, timeout: TIMEOUT_MS });

/**
 * Asks the URLs in order. When one fails or hasn't answered within HEDGE_DELAY_MS, the next is asked too, and the first
 * answer wins. A URL that was too slow is asked alongside the next one until it is fast again, so a hung node costs the
 * delay once, not on every call. There are no retries here, because main.ts retries whole passes.
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

/** Sends to every URL at once, so that inclusion doesn't depend on one node. */
export function broadcaster(rpcUrls: string[]) {
  // Not batched, so that a transaction never waits behind reads to the same URL.
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
  /** For slow, heavy reads, which go to one URL at a time instead of being hedged. */
  bulk: Client;
  /**
   * A separate client for the immutable conduit's votes. Calls sent together through one client share a JSON-RPC batch,
   * which only answers when its slowest call does.
   */
  v2Client: Client;
  broadcast: ReturnType<typeof broadcaster>;
  module: Address;
  conduit: Address;
  keeper: Address;
  voter: Address;
  ve: Address;
  v2?: V2 | undefined;
};

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
  chunk?: number;
  concurrency?: number;
};

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
 * When a node fails, every call in the multicall fails with what looks like a revert of the multicall contract. Only a
 * revert of the call's own contract counts.
 */
const reverted = (error: unknown, { address }: Call) =>
  error instanceof ContractFunctionExecutionError &&
  error.contractAddress !== undefined &&
  isAddressEqual(error.contractAddress, address) &&
  error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;

/** A node behind `pinned` wouldn't see a transaction mined in `pinned`, so `pinned` is used until it catches up. */
export async function blockAtLeast({ client }: Chain, pinned?: bigint): Promise<bigint> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  return pinned !== undefined && latest < pinned ? pinned : latest;
}

type Head = { number: bigint; timestamp: bigint };

/** The first and last blocks whose timestamps lie in [`from`, `to`), both found from one read of the latest block. */
export async function blocksBetween(client: Client, from: bigint, to: bigint): Promise<[bigint, bigint]> {
  const head = await client.getBlock();
  const [before, last] = await Promise.all([lastBlockBefore(client, from, head), lastBlockBefore(client, to, head)]);
  return [before + 1n, last];
}

/**
 * The last block before `time` (s), worked out from the latest block's time, since blocks come every BLOCK_MS. The
 * blocks either side of `time` are read to confirm it, and the lookup fails rather than give another block.
 */
export async function lastBlockBefore(client: Client, time: bigint, latest?: Head): Promise<bigint> {
  const head = latest ?? (await client.getBlock());
  if (head.timestamp < time) throw new Error(`the latest block, at ${head.timestamp}, is not past ${time} yet`);
  const ms = msOf(head);
  if (ms === undefined) throw new Error(`block ${head.number} has no timestampMs`);
  const found = head.number - (BigInt(ms) - time * 1000n) / BigInt(BLOCK_MS) - 1n;
  const [block, next] = await Promise.all([
    client.getBlock({ blockNumber: found }),
    client.getBlock({ blockNumber: found + 1n }),
  ]);
  if (block.timestamp >= time || next.timestamp < time) {
    throw new Error(
      `blocks ${found} and ${found + 1n}, at ${block.timestamp} and ${next.timestamp}, are not either side of ${time}`,
    );
  }
  return found;
}

async function multicall(
  client: Client,
  calls: readonly Call[],
  allowFailure: boolean,
  { blockNumber, chunk = CHUNK, concurrency = Infinity }: ReadOptions,
): Promise<unknown[]> {
  const at = blockNumber !== undefined ? { blockNumber } : {};
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

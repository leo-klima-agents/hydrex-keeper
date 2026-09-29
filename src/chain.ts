import { createPublicClient, createTransport, http, keccak256, shouldThrow, type Address, type Hex, type Transport } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi } from "./abi.ts";
import { describe, log } from "./log.ts";

export const WEEK = 7n * 24n * 60n * 60n;
// Calls per eth_call. Gas is not the limit (4,500 reads, about 57M gas, pass on mainnet.base.org); request size is:
// publicnode rejects a call of 2,264 reads and takes 1,132.
export const CHUNK = 1_000;

// The primary answers a pass's read in about 125 ms (370 ms at worst, over 15 reads on QuickNode): past this, the
// next URL is asked too.
export const HEDGE_DELAY = 250;
const TIMEOUT = 5_000; // a request still unanswered is abandoned

/**
 * The URLs in order, hedged: a request goes to the first; if it has not answered within HEDGE_DELAY, or failed, the
 * next is asked too, and so on, and the first answer wins, the earlier URLs' included. A URL that missed the delay is
 * asked together with the next until it answers within it again, so a hung primary costs HEDGE_DELAY once, not on
 * every call. A deterministic error (a revert) is returned as is. No retries: main.ts retries whole passes within
 * the pass deadline, where a transport retry would re-ask the primary and honour a Retry-After of tens of seconds.
 */
export function hedged(rpcUrls: string[]): Transport {
  return ({ chain }) => {
    // mainnet.base.org rejects JSON-RPC batches of more than 10 calls.
    const children = rpcUrls.map((url) => http(url, { batch: { batchSize: 10 }, timeout: TIMEOUT })({ chain, retryCount: 0 }));
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
          const hedge = setTimeout(() => (slow.add(i), ask()), slow.has(i) ? 0 : HEDGE_DELAY);
          children[i]!.request({ method, params }).then(
            (result) => {
              clearTimeout(hedge);
              if (Date.now() - t0 < HEDGE_DELAY) slow.delete(i);
              if (!done) (done = true), resolve(result);
            },
            (error: Error) => {
              clearTimeout(hedge);
              errors[i] = error;
              settled++;
              if (done) return;
              if (shouldThrow(error)) return (done = true), reject(error);
              if (i === started - 1) ask(); // failed before the next was asked: ask it now
              if (settled === started && started === children.length) (done = true), reject(errors[0]);
            },
          );
        };
        ask();
      });
    return createTransport({ key: "hedged", name: "Hedged", type: "hedged", request: request as never, retryCount: 0 });
  };
}

function makeClient(rpcUrls: string[]) {
  return createPublicClient({ chain: base, transport: hedged(rpcUrls), pollingInterval: 1_000 }).extend(publicActionsL2());
}

export type Client = ReturnType<typeof makeClient>;

export type Chain = {
  client: Client;
  module: Address;
  conduit: Address;
  keeper: Address;
  voter: Address;
  ve: Address;
  /** Sends a signed transaction to every URL at once; resolves with its hash once one accepts it (see `broadcast`). */
  broadcast: (signed: Hex, until: bigint) => Promise<Hex>;
};

/** The host of an RPC URL, for logs: provider URLs often carry their API key in the path. */
export const hostOf = (url: string) => URL.canParse(url) ? new URL(url).host : "invalid URL";

/**
 * Sends to every URL in parallel, so that inclusion does not depend on one node, and resolves as soon as one
 * accepts (or already holds) the transaction; the rest finish in the background and are logged. Rejects when none
 * accepts before `until` (ms).
 */
export function broadcaster(rpcUrls: string[]) {
  const transports = rpcUrls.map((url) => ({ host: hostOf(url), transport: http(url, { timeout: TIMEOUT }) }));
  return (signed: Hex, until: bigint): Promise<Hex> => {
    const hash = keccak256(signed);
    const timeout = Math.max(1, Math.min(TIMEOUT, Number(until - BigInt(Date.now()))));
    const sends = transports.map(async ({ host, transport }) => {
      try {
        await transport({ chain: base, retryCount: 0, timeout }).request({ method: "eth_sendRawTransaction", params: [signed] });
      } catch (error) {
        if (!/already known|known transaction|already imported/i.test(describe(error))) throw new Error(`${host}: ${describe(error)}`);
      }
      return host;
    });
    void Promise.allSettled(sends).then((settled) =>
      log.info("broadcast", {
        hash,
        accepted: settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : [])),
        rejected: settled.flatMap((s) => (s.status === "rejected" ? [describe(s.reason)] : [])),
      }),
    );
    return Promise.any(sends).then(
      () => hash,
      (error: AggregateError) => {
        throw new Error(`no RPC accepted the vote: ${error.errors.map(describe).join("; ")}`);
      },
    );
  };
}

/** Connects and derives every address from the module. */
export async function connect(module: Address, rpcUrls: string[]): Promise<Chain> {
  const client = makeClient(rpcUrls);
  const broadcast = broadcaster(rpcUrls);
  const read = (address: Address, abi: readonly unknown[], functionName: string) =>
    client.readContract({ address, abi, functionName } as never) as Promise<Address>;
  const [conduit, keeper] = await Promise.all([read(module, moduleAbi, "CONDUIT"), read(module, moduleAbi, "KEEPER")]);
  const [voter, ve] = await Promise.all([read(conduit, conduitAbi, "voter"), read(conduit, conduitAbi, "veToken")]);
  return { client, module, conduit, keeper, voter, ve, broadcast };
}

/**
 * How far the chain's clock is ahead of the local one, in ms, measured over `sampleMs` (at least one new 2 s block).
 * A new block is first seen 60 to 165 ms after its timestamp (measured against a local clock 36 ms off Google's), so
 * its timestamp at first sighting is real time to within about 0.2 s. Positive means the local clock is slow; NaN if
 * no new block was seen.
 */
export async function clockLag(client: Client, sampleMs = 4_000): Promise<number> {
  let last: bigint | undefined;
  let lag = Number.NaN;
  const end = Date.now() + sampleMs;
  while (Date.now() < end) {
    const t0 = Date.now();
    const block = await client.getBlock({ blockTag: "latest" });
    const at = (t0 + Date.now()) / 2;
    if (last !== undefined && block.number !== last) lag = Math.max(Number.isNaN(lag) ? -Infinity : lag, Number(block.timestamp) * 1000 - at);
    last = block.number;
    await new Promise((r) => setTimeout(r, 200));
  }
  return lag;
}

export type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

type ReadOptions = { blockNumber?: bigint; lenient?: boolean };

/**
 * One eth_call per CHUNK calls (viem's own calldata split is off: it turns one read into dozens of eth_calls,
 * which public nodes rate-limit). Every call must succeed unless `lenient`, which yields `undefined` for failures.
 */
export async function readMany<T>(client: Client, calls: readonly Call[], { blockNumber, lenient }: ReadOptions = {}): Promise<T[]> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const chunks = Array.from({ length: Math.ceil(calls.length / CHUNK) }, (_, i) => calls.slice(i * CHUNK, (i + 1) * CHUNK) as never);
  const results = await Promise.all(
    chunks.map(async (contracts) => {
      if (!lenient) return (await client.multicall({ contracts, allowFailure: false, batchSize: 0, ...at })) as T[];
      const settled = (await client.multicall({ contracts, allowFailure: true, batchSize: 0, ...at })) as { status: string; result?: unknown; error?: unknown }[];
      if (settled.every((r) => r.status === "failure")) throw settled[0]!.error;
      return settled.map((r) => (r.status === "success" ? r.result : undefined)) as T[];
    }),
  );
  return results.flat() as T[];
}

import { createPublicClient, fallback, http, keccak256, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi } from "./abi.ts";
import { describe, log } from "./log.ts";

export const WEEK = 7n * 24n * 60n * 60n;
// Calls per eth_call. Gas is not the limit (4,500 reads, about 57M gas, pass on mainnet.base.org); request size is:
// publicnode rejects a call of 2,264 reads and takes 1,132.
export const CHUNK = 1_000;

// The primary answers a pass's read in about 125 ms (370 ms at worst, over 15 reads on QuickNode), so a hanging
// primary costs half a second per call before the next URL answers, well inside the last pass's three seconds.
const PRIMARY_TIMEOUT = 500;
const TIMEOUT = 5_000;

function makeClient(rpcUrls: string[]) {
  // No transport-level retries: they would re-try the primary first and honour Retry-After with no regard for the
  // pass deadline; main.ts retries whole passes within it instead.
  const transports = rpcUrls.map((url, i) => http(url, { batch: true, timeout: i === 0 ? PRIMARY_TIMEOUT : TIMEOUT }));
  return createPublicClient({ chain: base, transport: fallback(transports, { retryCount: 0 }), pollingInterval: 1_000 }).extend(publicActionsL2());
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

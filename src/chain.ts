import { createPublicClient, fallback, http, type Address } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi } from "./abi.ts";

export const WEEK = 7n * 24n * 60n * 60n;
// Calls per eth_call. Gas is not the limit (4,500 reads, about 57M gas, pass on mainnet.base.org); request size is:
// publicnode rejects a call of 2,264 reads and takes 1,132.
export const CHUNK = 1_000;

function makeClient(rpcUrls: string[]) {
  // A hanging primary costs one short timeout per call before the next URL answers. No transport-level
  // retries: they would re-try the primary first and honour Retry-After with no regard for the pass deadline;
  // main.ts retries whole passes within it instead.
  const transports = rpcUrls.map((url, i) => http(url, { batch: true, timeout: i === 0 ? 3_000 : 5_000 }));
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
};

/** Connects and derives every address from the module. */
export async function connect(module: Address, rpcUrls: string[]): Promise<Chain> {
  const client = makeClient(rpcUrls);
  const read = (address: Address, abi: readonly unknown[], functionName: string) =>
    client.readContract({ address, abi, functionName } as never) as Promise<Address>;
  const [conduit, keeper] = await Promise.all([read(module, moduleAbi, "CONDUIT"), read(module, moduleAbi, "KEEPER")]);
  const [voter, ve] = await Promise.all([read(conduit, conduitAbi, "voter"), read(conduit, conduitAbi, "veToken")]);
  return { client, module, conduit, keeper, voter, ve };
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

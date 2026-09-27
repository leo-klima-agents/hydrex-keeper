import { createPublicClient, fallback, http, type Address } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi } from "./abi.ts";

export const WEEK = 7n * 24n * 60n * 60n;

function makeClient(rpcUrls: string[]) {
  // A hanging primary costs one short timeout per call before the next URL answers.
  const transports = rpcUrls.map((url, i) => http(url, { batch: true, ...(i === 0 ? { timeout: 3_000, retryCount: 0 } : { timeout: 5_000, retryDelay: 1_000 }) }));
  return createPublicClient({ chain: base, transport: fallback(transports), pollingInterval: 1_000 }).extend(publicActionsL2());
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
  const read = <const abi extends readonly unknown[]>(address: Address, abi: abi, functionName: string) =>
    client.readContract({ address, abi, functionName, args: [] } as never) as Promise<Address>;
  const [conduit, keeper] = await Promise.all([
    read(module, moduleAbi, "CONDUIT"),
    read(module, moduleAbi, "KEEPER"),
  ]);
  const [voter, ve] = await Promise.all([read(conduit, conduitAbi, "voter"), read(conduit, conduitAbi, "veToken")]);
  return { client, module, conduit, keeper, voter, ve };
}

export type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

type ReadOptions = { blockNumber?: bigint; lenient?: boolean };

/** One multicall; every call must succeed unless `lenient`, which yields `undefined` for failures. */
export async function readMany<T>(client: Client, calls: readonly Call[], { blockNumber, lenient }: ReadOptions = {}): Promise<T[]> {
  const contracts = calls as never;
  const at = blockNumber === undefined ? {} : { blockNumber };
  if (!lenient) return (await client.multicall({ contracts, allowFailure: false, ...at })) as T[];
  const results = (await client.multicall({ contracts, allowFailure: true, ...at })) as { status: string; result?: unknown; error?: unknown }[];
  if (results.length && results.every((r) => r.status === "failure")) throw results[0]!.error;
  return results.map((r) => (r.status === "success" ? r.result : undefined)) as T[];
}

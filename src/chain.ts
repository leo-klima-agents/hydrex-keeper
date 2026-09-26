import { createPublicClient, fallback, http, type Address } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi } from "./abi.ts";

export const WEEK = 7n * 24n * 60n * 60n;

function makeClient(rpcUrls: string[]) {
  return createPublicClient({ chain: base, transport: fallback(rpcUrls.map((url) => http(url))) }).extend(publicActionsL2());
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

/** Multicall in chunks; every call must succeed unless `lenient`, which yields `undefined` for failures. */
export async function readMany<T>(client: Client, calls: readonly Call[], { blockNumber, lenient }: ReadOptions = {}, chunk = 150): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const contracts = calls.slice(i, i + chunk) as never;
    const at = blockNumber === undefined ? {} : { blockNumber };
    if (lenient) {
      const results = (await client.multicall({ contracts, allowFailure: true, ...at })) as { status: string; result?: unknown }[];
      out.push(...(results.map((r) => (r.status === "success" ? r.result : undefined)) as T[]));
    } else {
      out.push(...((await client.multicall({ contracts, allowFailure: false, ...at })) as T[]));
    }
  }
  return out;
}

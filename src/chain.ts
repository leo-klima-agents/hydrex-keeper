import { createPublicClient, fallback, http, type Address, type PublicClient, type Transport } from "viem";
import { base } from "viem/chains";
import { conduitAbi, moduleAbi } from "./abi.ts";

export const WEEK = 7n * 24n * 60n * 60n;

export type Client = PublicClient<Transport, typeof base>;

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
  const client = createPublicClient({ chain: base, transport: fallback(rpcUrls.map((url) => http(url))) });
  const read = <const abi extends readonly unknown[]>(address: Address, abi: abi, functionName: string) =>
    client.readContract({ address, abi, functionName, args: [] } as never) as Promise<Address>;
  const [conduit, keeper] = await Promise.all([
    read(module, moduleAbi, "CONDUIT"),
    read(module, moduleAbi, "KEEPER"),
  ]);
  const [voter, ve] = await Promise.all([read(conduit, conduitAbi, "voter"), read(conduit, conduitAbi, "veToken")]);
  return { client, module, conduit, keeper, voter, ve };
}

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** Multicall in chunks; every call must succeed. */
export async function readMany<T>(client: Client, calls: readonly Call[], chunk = 150): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const results = await client.multicall({ contracts: calls.slice(i, i + chunk) as never, allowFailure: false });
    out.push(...(results as T[]));
  }
  return out;
}

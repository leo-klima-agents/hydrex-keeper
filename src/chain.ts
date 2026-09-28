import { createPublicClient, fallback, http, type Address } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { conduitAbi, moduleAbi, voterAbi } from "./abi.ts";

export const WEEK = 7n * 24n * 60n * 60n;

export const now = () => BigInt(Math.floor(Date.now() / 1000));

function makeClient(rpcUrls: string[]) {
  // A short first timeout fails over fast from a hung provider; mainnet.base.org rejects batches over 10 calls.
  const transports = rpcUrls.map((url, i) => http(url, { batch: { batchSize: 10 }, timeout: i === 0 ? 3_000 : 5_000 }));
  const client = createPublicClient({ chain: base, transport: fallback(transports), pollingInterval: 1_000 });
  return client.extend(publicActionsL2());
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

export async function connect(module: Address, rpcUrls: string[]): Promise<Chain> {
  const client = makeClient(rpcUrls);
  const [conduit, keeper] = (await readMany<Address>(client, [
    { address: module, abi: moduleAbi, functionName: "CONDUIT" },
    { address: module, abi: moduleAbi, functionName: "KEEPER" },
  ])) as [Address, Address];
  const [voter, ve] = (await readMany<Address>(client, [
    { address: conduit, abi: conduitAbi, functionName: "voter" },
    { address: conduit, abi: conduitAbi, functionName: "veToken" },
  ])) as [Address, Address];
  return { client, module, conduit, keeper, voter, ve };
}

export type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

export function voterCall({ voter }: Chain, functionName: string, args: readonly unknown[] = []): Call {
  return { address: voter, abi: voterAbi, functionName, args };
}

type ReadOptions = { blockNumber?: bigint; lenient?: boolean };

/** One multicall; every call must succeed unless `lenient`, which yields `undefined` for failures. */
export async function readMany<T>(
  client: Client,
  calls: readonly Call[],
  { blockNumber, lenient = false }: ReadOptions = {},
): Promise<T[]> {
  if (calls.length === 0) return [];
  const at = blockNumber === undefined ? {} : { blockNumber };
  const results = await client.multicall({ contracts: calls as never, allowFailure: lenient, ...at });
  if (!lenient) return results as T[];
  const settled = results as { status: string; result?: unknown; error?: unknown }[];
  if (settled.every((r) => r.status === "failure")) throw settled[0]!.error;
  return settled.map((r) => (r.status === "success" ? r.result : undefined)) as T[];
}

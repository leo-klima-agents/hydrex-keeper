import {
  createPublicClient,
  createTransport,
  http,
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

export const now = () => BigInt(Math.floor(Date.now() / 1000));

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
        throw new Error(`no RPC accepted the vote: ${reasons(error.errors).join("; ")}`);
      },
    );
  };
}

function makeClient(rpcUrls: string[]) {
  const client = createPublicClient({ chain: base, transport: hedged(rpcUrls), pollingInterval: 1_000 });
  return client.extend(publicActionsL2());
}

export type Client = ReturnType<typeof makeClient>;

export type Chain = {
  client: Client;
  broadcast: ReturnType<typeof broadcaster>;
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
  return { client, broadcast: broadcaster(rpcUrls), module, conduit, keeper, voter, ve };
}

export type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

export function voterCall({ voter }: Chain, functionName: string, args: readonly unknown[] = []): Call {
  return { address: voter, abi: voterAbi, functionName, args };
}

type ReadOptions = { blockNumber?: bigint; blockTag?: "pending" | undefined; lenient?: boolean };

/**
 * One eth_call per CHUNK calls, sent in parallel, so that a read comes from one block and public nodes see few
 * requests. Every call must succeed unless `lenient`, which yields `undefined` for failures.
 */
export async function readMany<T>(
  client: Client,
  calls: readonly Call[],
  { blockNumber, blockTag, lenient = false }: ReadOptions = {},
): Promise<T[]> {
  const at = blockNumber !== undefined ? { blockNumber } : blockTag ? { blockTag } : {};
  const chunks = Array.from({ length: Math.ceil(calls.length / CHUNK) }, (_, i) =>
    calls.slice(i * CHUNK, (i + 1) * CHUNK),
  );
  const results = await Promise.all(
    chunks.map((contracts) =>
      client.multicall({ contracts: contracts as never, allowFailure: lenient, batchSize: 0, ...at }),
    ),
  );
  if (!lenient) return results.flat() as T[];
  const settled = results.flat() as { status: string; result?: unknown; error?: unknown }[];
  if (settled.length && settled.every((r) => r.status === "failure")) throw settled[0]!.error;
  return settled.map((r) => (r.status === "success" ? r.result : undefined)) as T[];
}

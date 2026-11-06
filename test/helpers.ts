import type { TestContext } from "node:test";
import type { Address, Hex } from "viem";
import { immutableAbi, klimaModuleAbi } from "../src/abi.ts";
import type { ByConduit, Chain, Client, Conduit } from "../src/chain.ts";
import { broadcastTx } from "../src/vote.ts";

/** Where each conduit is, and its key: the Klima conduit is reached through its module. */
export type Places = {
  klima: { address: Address; from: Address; module: Address };
  immutable: { address: Address; from: Address; priced?: Address[] };
};

/** Both conduits as `connect` builds them, each sending through `clients` or the one client given. */
export function conduitsOf({ klima, immutable }: Places, clients: Client | ByConduit<Client>): ByConduit<Conduit> {
  const both = clients as Partial<ByConduit<Client>>;
  const [klimaClient, immutableClient] =
    both.klima && both.immutable ? [both.klima, both.immutable] : [clients, clients];
  return {
    klima: {
      name: "klima",
      label: "the Klima conduit",
      address: klima.address,
      role: "keeper",
      from: klima.from,
      to: klima.module,
      abi: klimaModuleAbi,
      open: false,
      client: klimaClient as Client,
    },
    immutable: {
      name: "immutable",
      label: "the immutable conduit",
      address: immutable.address,
      role: "proposer",
      from: immutable.from,
      to: immutable.address,
      abi: immutableAbi,
      open: true,
      client: immutableClient as Client,
      priced: immutable.priced ?? [],
    },
  };
}

export type Line = { severity: string; message: string; error?: string } & Record<string, unknown>;

const isLine = (chunk: unknown): chunk is string => typeof chunk === "string" && chunk.startsWith("{");

/**
 * The JSON lines logged while `act` runs. What the test runner writes to stdout meanwhile, such as the result of the
 * test before, still goes out.
 */
export async function logged(t: { mock: TestContext["mock"] }, act: () => unknown): Promise<Line[]> {
  const original = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  const write = t.mock.method(process.stdout, "write", (...args: unknown[]) => isLine(args[0]) || original(...args));
  try {
    await act();
  } finally {
    write.mock.restore();
  }
  return write.mock.calls.flatMap(({ arguments: [chunk] }) => (isLine(chunk) ? [JSON.parse(chunk) as Line] : []));
}

/**
 * Leaves a transaction of `from` at `nonce` that this run sent and no block holds yet. With `held`, a node still has it,
 * as it has a vote in flight. Without, no node does, as for one that every node refused or dropped.
 */
export async function sentNotMined(chain: Chain, from: Address, nonce: number, held = true): Promise<void> {
  const { broadcast, known } = chain;
  chain.broadcast = (async () => {
    throw new Error("no RPC accepted the transaction");
  }) as never;
  const tx = {
    chainId: 8453,
    to: from,
    data: "0x" as Hex,
    gas: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    nonce,
  };
  await broadcastTx(chain, { tx, from, signed: "0x01" }, Number.MAX_SAFE_INTEGER).catch(() => undefined);
  chain.broadcast = broadcast;
  chain.known = async (hashes) => (held && hashes.length > 0 ? true : known(hashes));
}

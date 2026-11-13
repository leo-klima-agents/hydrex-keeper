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
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { klimaAbi, immutableAbi, klimaModuleAbi, voterAbi } from "./abi.ts";
import { errorMessage, log } from "./log.ts";

export const WEEK = 7n * 24n * 60n * 60n;
export const CHUNK = 1_000; // calls per eth_call. publicnode accepts 1,132 and rejects 2,264.
export const HEDGE_DELAY_MS = 250; // a healthy node answers a read in about 125 ms
const TIMEOUT_MS = 5_000;
const BULK_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 2_000;
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
/** A node's answer to a transaction sent to every URL, `ms` after it was sent. */
type Answer = { host: string; ms: number; error?: string };

export function broadcaster(rpcUrls: string[]) {
  // Not batched, so that a transaction never waits behind reads to the same URL.
  const nodes = rpcUrls.map((url) => ({ host: hostOf(url), transport: http(url) }));
  return (signed: Hex, until: number): Promise<Hex> => {
    const hash = keccak256(signed);
    const started = Date.now();
    const timeout = Math.max(1, Math.min(TIMEOUT_MS, until - started));
    const answers = nodes.map(async ({ host, transport }): Promise<Answer> => {
      try {
        const node = transport({ chain: base, retryCount: 0, timeout });
        await node.request({ method: "eth_sendRawTransaction", params: [signed] });
      } catch (error) {
        const message = errorMessage(error);
        if (!/already known|known transaction|already imported/i.test(message)) {
          return { host, ms: Date.now() - started, error: message };
        }
      }
      return { host, ms: Date.now() - started };
    });
    // How long each node took, to time the votes: the first to accept forwards the transaction to the sequencer.
    void Promise.all(answers).then((all) =>
      log.info("broadcast", {
        hash,
        accepted: all.filter((a) => a.error === undefined).map(({ host, ms }) => ({ host, ms })),
        rejected: all.filter((a) => a.error !== undefined),
      }),
    );
    const accepted = answers.map(async (answer) => {
      const { host, error } = await answer;
      if (error !== undefined) throw new Error(`${host}: ${error}`);
    });
    return Promise.any(accepted).then(
      () => hash,
      (error: AggregateError) => {
        const reasons = error.errors.map((e) => (e as Error).message);
        throw new Error(`no RPC accepted the transaction: ${reasons.join("; ")}`);
      },
    );
  };
}

/**
 * Whether a node has any of the transactions, pending or in a block, asking every URL. A node keeps each transaction it
 * forwarded to the sequencer until the transaction lands or is dropped, and transactions are sent to every URL, so when
 * the nodes that answer have none, none can land. Undefined when no node answered.
 */
export function finder(rpcUrls: string[]) {
  const nodes = rpcUrls.map((url) => http(url));
  return async (hashes: readonly Hex[]): Promise<boolean | undefined> => {
    if (hashes.length === 0) return false;
    const asks = nodes.flatMap((transport) => {
      const node = transport({ chain: base, retryCount: 0, timeout: LOOKUP_TIMEOUT_MS });
      return hashes.map((hash) => node.request({ method: "eth_getTransactionByHash", params: [hash] }));
    });
    return new Promise((resolve) => {
      let settled = 0;
      let answered = false;
      for (const ask of asks) {
        ask
          .then((tx) => {
            answered = true;
            if (tx !== null) resolve(true);
          })
          .catch(() => undefined)
          .finally(() => ++settled === asks.length && resolve(answered ? false : undefined));
      }
    });
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

/** The two conduits the job votes and claims for, named after their contracts. */
export const CONDUITS = ["klima", "immutable"] as const;

export type ConduitName = (typeof CONDUITS)[number];

/** One value for each conduit. */
export type ByConduit<T> = { [name in ConduitName]: T };

export const byConduit = <T>(make: (name: ConduitName) => T): ByConduit<T> => ({
  klima: make("klima"),
  immutable: make("immutable"),
});

export const otherOf = (name: ConduitName): ConduitName => (name === "klima" ? "immutable" : "klima");

/** What sets a conduit apart, from its contracts. */
export type Traits = {
  /** For logs and errors: "the Klima conduit", "the immutable conduit". */
  label: string;
  /** Its key's role on chain. */
  role: "keeper" | "proposer";
  /** The conduit's ABI, for calls to its address. */
  abi: Abi;
  /** The ABI of `to`, where its key's votes and claims go. */
  toAbi: Abi;
  /** Anyone can vote for an open conduit, so a vote in force may not be its key's. */
  open: boolean;
  /**
   * Whether it checks votes on chain: it only takes a vote whose score, counted in the tokens it prices with, beats the
   * vote in force.
   */
  checks: boolean;
  /** The most pools in a vote. */
  maxPools: number;
  /** What it does with the rewards it claims. */
  payout: "retire" | "as is";
  /** Rough gas of a claim before its swaps and pairs. The simulation has the final say. */
  claimGas: bigint;
  /** Owners whose veNFTs it doesn't claim for, by lowercase address. */
  excludedOwners: ReadonlyMap<string, string>;
  /** Whether its treasury pays for both keys' ETH. One conduit's does. */
  fundsKeys: boolean;
};

export const TRAITS: ByConduit<Traits> = {
  klima: {
    label: "the Klima conduit",
    role: "keeper", // its Safe module's KEEPER
    abi: klimaAbi,
    toAbi: klimaModuleAbi,
    open: false,
    checks: false,
    maxPools: 40, // more pools could go over Base's gas limit per transaction
    payout: "retire", // swaps rewards to kVCM, retires part of it and pays out the rest
    claimGas: 1_300_000n,
    excludedOwners: new Map([["0xa79cd47655156b299762dfe92a67980805ce5a31", "Klima Foundation"]]),
    fundsKeys: false,
  },
  immutable: {
    label: "the immutable conduit",
    role: "proposer", // anyone can propose its vote
    abi: immutableAbi,
    toAbi: immutableAbi,
    open: true,
    checks: true,
    maxPools: 20, // the conduit's MAX_POOLS
    payout: "as is", // minus its fee
    claimGas: 400_000n,
    excludedOwners: new Map(),
    fundsKeys: true,
  },
};

/** Where a conduit is, and the key that votes and claims for it. */
export type Place = {
  /** What the Voter records the conduit's votes for. */
  address: Address;
  /** The key's address. */
  from: Address;
  /** Where the key's votes and claims go: the Klima conduit's Safe module, or the immutable conduit itself. */
  to: Address;
  /** For a conduit that checks votes on chain: the tokens it prices with. Empty for the others. */
  priced: Address[];
};

export type Conduit = Traits &
  Place & {
    name: ConduitName;
    /**
     * The conduit's own client for its transactions. Calls sent together through one client share a JSON-RPC batch,
     * which only answers when its slowest call does.
     */
    client: Client;
  };

/** The conduit `name` at `place`, with its traits. */
export const conduitOf = (name: ConduitName, place: Place, client: Client): Conduit => ({
  name,
  ...TRAITS[name],
  ...place,
  client,
});

export type Chain = {
  /** For reads. */
  client: Client;
  /** For slow, heavy reads, which go to one URL at a time instead of being hedged. */
  bulk: Client;
  broadcast: ReturnType<typeof broadcaster>;
  known: ReturnType<typeof finder>;
  voter: Address;
  ve: Address;
  conduits: ByConduit<Conduit>;
};

/** Where to find each conduit: the Klima conduit through its Safe module, the immutable conduit directly. */
export type Settings = { klima: { module: Address }; immutable: { conduit: Address; proposer: Address } };

const MAX_PRICED_TOKENS = 4; // a checking conduit's limit

export async function connect(settings: Settings, rpcUrls: string[]): Promise<Chain> {
  const client = makeClient(hedged(rpcUrls));
  const { voter, ve, places } = await readAddresses(client, settings);
  return {
    client,
    bulk: makeClient(bulkTransport(rpcUrls)),
    broadcast: broadcaster(rpcUrls),
    known: finder(rpcUrls),
    voter,
    ve,
    conduits: byConduit((name) => conduitOf(name, places[name], makeClient(hedged(rpcUrls)))),
  };
}

/**
 * Where both conduits and their keys are. The Klima conduit and its keeper are read from its Safe module, and a
 * checking conduit's priced tokens from it. Both conduits must use the same Voter and VotingEscrow, and the two keys must
 * differ: they send at the same time, and their nonces are tracked separately.
 */
export async function readAddresses(
  client: Client,
  { klima, immutable }: Settings,
): Promise<{ voter: Address; ve: Address; places: ByConduit<Place> }> {
  const [klimaConduit, keeper] = (await readMany<Address>(client, [
    call(klima.module, klimaModuleAbi, "CONDUIT"),
    call(klima.module, klimaModuleAbi, "KEEPER"),
  ])) as [Address, Address];
  if (isAddressEqual(immutable.proposer, keeper)) {
    throw new Error(`IMMUTABLE_PROPOSER is the KEEPER of KLIMA_MODULE, ${keeper}: each conduit needs a key of its own`);
  }
  const located: ByConduit<Omit<Place, "priced">> = {
    klima: { address: klimaConduit, from: keeper, to: klima.module },
    immutable: { address: immutable.conduit, from: immutable.proposer, to: immutable.conduit },
  };
  const conduitCall = (name: ConduitName, functionName: string, args?: readonly unknown[]) =>
    call(located[name].address, TRAITS[name].abi, functionName, args);
  const checking = CONDUITS.filter((name) => TRAITS[name].checks);
  const pricedCalls = checking.flatMap((name) =>
    Array.from({ length: MAX_PRICED_TOKENS }, (_, i) => conduitCall(name, "pricedTokens", [BigInt(i)])),
  );
  const [used, entries] = await Promise.all([
    readMany<Address>(
      client,
      CONDUITS.flatMap((name) => [conduitCall(name, "voter"), conduitCall(name, "veToken")]),
    ),
    readEach<readonly [Address, ...unknown[]]>(client, pricedCalls),
  ]);
  const [voter, ve] = used as [Address, Address];
  for (const [i, name] of CONDUITS.entries()) {
    const [otherVoter, otherVe] = used.slice(2 * i) as [Address, Address];
    if (!isAddressEqual(otherVoter, voter) || !isAddressEqual(otherVe, ve)) {
      const { address } = located[name];
      throw new Error(`${address} uses Voter ${otherVoter} and VotingEscrow ${otherVe}, not ${voter} and ${ve}`);
    }
  }
  const places = byConduit((name): Place => {
    const k = checking.indexOf(name);
    if (k < 0) return { ...located[name], priced: [] };
    const own = entries.slice(k * MAX_PRICED_TOKENS, (k + 1) * MAX_PRICED_TOKENS);
    const priced = own.flatMap((entry) => (entry ? [entry[0]] : []));
    if (priced.length === 0) throw new Error(`${located[name].address} prices no token`);
    return { ...located[name], priced };
  });
  return { voter, ve, places };
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

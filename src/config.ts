import { getAddress } from "viem";
import { byConduit, type ByConduit, type Settings } from "./chain.ts";

// Tried after BASE_RPC_URLS. They are rate-limited, so they are only a fallback.
export const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];

export type Config = {
  dryRun: boolean;
  /** Votes now instead of a day before the flip. */
  immediately: boolean;
  /** Claims now, whatever the schedule says. */
  claimNow: boolean;
  settings: Settings;
  /** The KMS key version of each conduit's key. Only a dry run goes without. */
  keyVersions: ByConduit<string | undefined>;
  rpcUrls: string[];
};

/**
 * Throws on the first setting that is missing or wrong, before anything is read from the chain. Each conduit's settings
 * start with its name: KLIMA_MODULE and KLIMA_KMS_KEY_VERSION, IMMUTABLE_CONDUIT, IMMUTABLE_PROPOSER and
 * IMMUTABLE_KMS_KEY_VERSION.
 */
export function configOf(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Config {
  const dryRun = argv.includes("--dry-run");
  const immediately = argv.includes("--now");
  const claimNow = argv.includes("--claim");
  if (immediately && claimNow) throw new Error("--now and --claim exclude each other");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const address = (name: string) => {
    const value = required(name);
    try {
      return getAddress(value);
    } catch {
      throw new Error(`${name} is not an address: ${value}`);
    }
  };
  const settings: Settings = {
    klima: { module: address("KLIMA_MODULE") },
    immutable: { conduit: address("IMMUTABLE_CONDUIT"), proposer: address("IMMUTABLE_PROPOSER") },
  };
  const keyVersions = byConduit((name) => {
    const variable = `${name.toUpperCase()}_KMS_KEY_VERSION`;
    return dryRun ? env[variable] || undefined : required(variable);
  });
  const rpcUrls = [
    ...new Set([...required("BASE_RPC_URLS").split(","), ...PUBLIC_RPCS].map((url) => url.trim()).filter(Boolean)),
  ];
  // As sh/lib.sh checks: the two keys send at the same time, and each needs nonces of its own.
  const keyOf = (version: string) => version.replace(/\/cryptoKeyVersions\/[^/]*$/, "");
  const { klima, immutable } = keyVersions;
  if (klima && immutable && keyOf(klima) === keyOf(immutable)) throw new Error("each conduit needs a key of its own");
  return { dryRun, immediately, claimNow, settings, keyVersions, rpcUrls };
}

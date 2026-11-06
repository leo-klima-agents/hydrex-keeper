import { getAddress, type Address } from "viem";

// Tried after BASE_RPC_URLS. They are rate-limited, so they are only a fallback.
export const PUBLIC_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];

export type Config = {
  dryRun: boolean;
  /** Votes now instead of a day before the flip. */
  immediately: boolean;
  /** Claims now, whatever the schedule says. */
  claimNow: boolean;
  module: Address;
  /** The Klima conduit's keeper's KMS key version. Only a dry run goes without. */
  keyVersion: string | undefined;
  immutable: { conduit: Address; proposer: Address };
  /** The proposer's KMS key version. Only a dry run goes without. */
  proposerKeyVersion: string | undefined;
  rpcUrls: string[];
};

/** Throws on the first setting that is missing or wrong, before anything is read from the chain. */
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
  const keyVersion = (name: string) => (dryRun ? env[name] || undefined : required(name));
  const config: Config = {
    dryRun,
    immediately,
    claimNow,
    module: address("MODULE"),
    keyVersion: keyVersion("KMS_KEY_VERSION"),
    immutable: { conduit: address("CONDUIT"), proposer: address("PROPOSER") },
    proposerKeyVersion: keyVersion("PROPOSER_KMS_KEY_VERSION"),
    rpcUrls: [
      ...new Set([...required("BASE_RPC_URLS").split(","), ...PUBLIC_RPCS].map((url) => url.trim()).filter(Boolean)),
    ],
  };
  // As sh/lib.sh checks: the two keys send at the same time, and each needs nonces of its own.
  const keyOf = (version: string) => version.replace(/\/cryptoKeyVersions\/[^/]*$/, "");
  if (config.keyVersion && config.proposerKeyVersion && keyOf(config.keyVersion) === keyOf(config.proposerKeyVersion)) {
    throw new Error("the proposer needs its own key, not the keeper's");
  }
  return config;
}

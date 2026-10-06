import { getAddress, type Address } from "viem";

export type Whitelist = { token: Address; name: string }[];

/** The tokens of tokens.json, at least one. */
export function parseWhitelist(json: string): Whitelist {
  const whitelist = (JSON.parse(json) as Whitelist).map((w) => ({ token: getAddress(w.token), name: String(w.name) }));
  if (whitelist.length === 0) throw new Error("tokens.json is empty");
  return whitelist;
}

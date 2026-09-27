import { getAddress, type Address } from "viem";

export type Whitelist = { pool: Address; name: string }[];

/** The pools of pools.json: at least one, none twice, since a vote naming a pool twice reverts. */
export function parseWhitelist(json: string): Whitelist {
  const whitelist = (JSON.parse(json) as Whitelist).map((w) => ({ pool: getAddress(w.pool), name: String(w.name) }));
  if (whitelist.length === 0) throw new Error("pools.json is empty");
  const repeated = whitelist.filter((w, i) => whitelist.findIndex((x) => x.pool === w.pool) !== i);
  if (repeated.length) throw new Error(`pools.json lists ${repeated.map((w) => w.pool).join(", ")} more than once`);
  return whitelist;
}

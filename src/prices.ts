import { setTimeout as sleep } from "node:timers/promises";
import type { Address } from "viem";
import { errorMessage, log } from "./log.ts";

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;
const REFRESH_BUDGET_MS = 20_000; // how close to `until` the last set is reused
const REUSE_AGE_MS = 60_000; // how long the last set is reused regardless
const SPREAD = 1.2; // quotes further apart than this ratio are logged

export type Prices = Map<Address, number>;

/** USD prices by lowercase address; unknown tokens are absent. `until` (ms) bounds retries and timeouts. */
export type PriceSource = { name: string; get: (tokens: Address[], until: number) => Promise<Prices> };

const lower = (tokens: Address[]) => [...new Set(tokens.map((t) => t.toLowerCase() as Address))];

const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const isObject = (body: unknown): body is Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

/** Retried with backoff while there is time; `valid` rejects a malformed 200. Errors name the source, not the URL. */
async function getJson(
  name: string,
  url: string,
  init: RequestInit,
  valid: (body: unknown) => boolean,
  fetchFn: typeof fetch,
  until: number,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await sleep(delay);
    }
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, until - Date.now())));
      const response = await fetchFn(url, { ...init, signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!valid(body)) throw new Error("malformed response");
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${name} unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** DefiLlama, keyless, 50 tokens per request. */
export function defillama(fetchFn: typeof fetch = fetch): PriceSource {
  type Body = { coins: Record<string, { price?: unknown }> };
  return {
    name: "DefiLlama",
    async get(tokens, until) {
      const parts = chunks(lower(tokens), 50);
      const bodies = await Promise.all(
        parts.map((part) => {
          const url = `https://coins.llama.fi/prices/current/${part.map((t) => `base:${t}`).join(",")}`;
          const valid = (b: unknown) => isObject(b) && isObject(b.coins);
          return getJson("DefiLlama", url, {}, valid, fetchFn, until) as Promise<Body>;
        }),
      );
      const out: Prices = new Map();
      for (const [i, body] of bodies.entries()) {
        for (const [key, coin] of Object.entries(body.coins)) {
          const token = key.slice("base:".length).toLowerCase() as Address;
          const price = positive(coin.price);
          if (parts[i]!.includes(token) && price !== undefined) out.set(token, price);
        }
      }
      return out;
    },
  };
}

/** Alchemy's Prices API, 25 tokens per request. The key is in the URL. */
export function alchemy(apiKey: string, fetchFn: typeof fetch = fetch): PriceSource {
  type Body = { data: { address: string; prices?: { currency: string; value: string }[] }[] };
  return {
    name: "Alchemy",
    async get(tokens, until) {
      const url = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`;
      const bodies = await Promise.all(
        chunks(lower(tokens), 25).map((part) => {
          const init = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ addresses: part.map((address) => ({ network: "base-mainnet", address })) }),
          };
          const valid = (b: unknown) => isObject(b) && Array.isArray(b.data);
          return getJson("Alchemy", url, init, valid, fetchFn, until) as Promise<Body>;
        }),
      );
      const out: Prices = new Map();
      for (const entry of bodies.flatMap((b) => b.data)) {
        const price = positive(Number(entry.prices?.find((p) => p.currency === "usd")?.value));
        if (price !== undefined) out.set(entry.address.toLowerCase() as Address, price);
      }
      return out;
    },
  };
}

/** CoinGecko's Demo API, 100 tokens per request. */
export function coingecko(apiKey: string, fetchFn: typeof fetch = fetch): PriceSource {
  type Body = Record<string, { usd?: unknown }>;
  return {
    name: "CoinGecko",
    async get(tokens, until) {
      const bodies = await Promise.all(
        chunks(lower(tokens), 100).map((part) => {
          const url = `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${part.join(",")}&vs_currencies=usd`;
          const init = { headers: { "x-cg-demo-api-key": apiKey } };
          return getJson("CoinGecko", url, init, isObject, fetchFn, until) as Promise<Body>;
        }),
      );
      const out: Prices = new Map();
      for (const [token, quote] of bodies.flatMap((b) => Object.entries(b))) {
        const price = positive(quote?.usd);
        if (price !== undefined) out.set(token.toLowerCase() as Address, price);
      }
      return out;
    },
  };
}

/**
 * Asks every source for every token, in parallel. A price is the median of three quotes, the lower of two (overpricing
 * a bribe would draw votes to it), or the only one. Fails only if every source does.
 */
export function combined(sources: PriceSource[]): PriceSource {
  return {
    name: sources.map((s) => s.name).join("+"),
    async get(tokens, until) {
      const distinct = lower(tokens);
      const settled = await Promise.allSettled(sources.map((s) => s.get(distinct, until)));
      const failures = settled.flatMap((s) => (s.status === "rejected" ? [errorMessage(s.reason)] : []));
      const maps = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      if (maps.length === 0) throw new Error(`no price source answered: ${failures.join("; ")}`);
      if (failures.length) log.warning("price source failed", { reasons: failures });
      const out: Prices = new Map();
      for (const token of distinct) {
        const quotes = maps.flatMap((m) => (m.has(token) ? [m.get(token)!] : [])).sort((a, b) => a - b);
        if (quotes.length === 0) continue;
        if (quotes.at(-1)! / quotes[0]! > SPREAD) log.warning("price sources disagree", { token, quotes });
        out.set(token, quotes.length >= 3 ? quotes[Math.floor(quotes.length / 2)]! : quotes[0]!);
      }
      return out;
    },
  };
}

/**
 * Fetches at every call; reuses the last set while it is under a minute old or near `until`, if it covers every token,
 * or if the fetch fails.
 */
export function priceFeed(source: PriceSource): (tokens: Address[], until?: number) => Promise<Prices> {
  let last: { at: number; requested: Set<Address>; map: Prices } | undefined;
  return async (tokens, until = Infinity) => {
    const requested = lower(tokens);
    const reuse = last && (Date.now() - last.at < REUSE_AGE_MS || until - Date.now() < REFRESH_BUDGET_MS);
    if (reuse && requested.every((t) => last!.requested.has(t))) return last!.map;
    try {
      last = { at: Date.now(), requested: new Set(requested), map: await source.get(requested, until) };
    } catch (error) {
      if (!last) throw error;
      log.warning("using the last prices", { ageMs: Date.now() - last.at, reason: errorMessage(error) });
    }
    return last.map;
  };
}

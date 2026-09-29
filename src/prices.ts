import type { Address } from "viem";
import { describe, log } from "./log.ts";

// USD prices of reward tokens on Base: DefiLlama, and Alchemy and CoinGecko when their keys are set. Tokens a source
// does not know are absent from its result.
const ATTEMPTS = 3;
const TIMEOUT = 15_000;
const REFRESH_BUDGET = 20_000; // ms left before `until` under which a cached set is served rather than refreshed
const SPREAD = 1.2; // quotes further apart than this ratio are logged

export type Prices = Map<Address, number>;

/** `get` resolves with the prices it found; `until` (ms) bounds its retries and timeouts. */
export type PriceSource = { name: string; get: (tokens: Address[], until: number) => Promise<Prices> };

const lower = (tokens: Address[]) => [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** A JSON body, retried with backoff while there is time before `until`; `valid` rejects a malformed 200. */
async function getJson(name: string, fetchFn: typeof fetch, until: number, url: string, init: RequestInit, valid: (body: unknown) => boolean, attempts = ATTEMPTS): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT, until - Date.now()))) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!valid(body)) throw new Error("malformed response");
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  // The message names the source, never the URL: Alchemy's carries its key.
  throw new Error(`${name} unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** DefiLlama `coins.llama.fi`, no key, 50 tokens per request. */
export function defillama(fetchFn: typeof fetch = fetch): PriceSource {
  return {
    name: "DefiLlama",
    async get(tokens, until) {
      const parts = chunks(lower(tokens), 50);
      const bodies = await Promise.all(
        parts.map((part) =>
          getJson("DefiLlama", fetchFn, until, `https://coins.llama.fi/prices/current/${part.map((t) => `base:${t}`).join(",")}`, {}, (b) => typeof (b as { coins?: unknown } | null)?.coins === "object" && (b as { coins: unknown }).coins !== null),
        ),
      );
      const out: Prices = new Map();
      for (const [i, body] of bodies.entries()) {
        for (const [key, coin] of Object.entries((body as { coins: Record<string, { price?: unknown }> }).coins)) {
          const token = key.slice("base:".length).toLowerCase() as Address;
          const price = positive(coin.price);
          if (parts[i]!.includes(token) && price !== undefined) out.set(token, price);
        }
      }
      return out;
    },
  };
}

/** Alchemy's Prices API, 25 tokens per request, the key in the URL. */
export function alchemy(apiKey: string, fetchFn: typeof fetch = fetch): PriceSource {
  type Body = { data: { address: string; prices?: { currency: string; value: string }[] }[] };
  return {
    name: "Alchemy",
    async get(tokens, until) {
      const bodies = await Promise.all(
        chunks(lower(tokens), 25).map((part) =>
          getJson("Alchemy", fetchFn, until, `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ addresses: part.map((address) => ({ network: "base-mainnet", address })) }),
          }, (b) => Array.isArray((b as Partial<Body> | null)?.data)),
        ),
      );
      const out: Prices = new Map();
      for (const entry of bodies.flatMap((b) => (b as Body).data)) {
        const price = positive(Number(entry.prices?.find((p) => p.currency === "usd")?.value));
        if (price !== undefined) out.set(entry.address.toLowerCase() as Address, price);
      }
      return out;
    },
  };
}

/** CoinGecko's Demo API with its key (keyless, it allows one token per request and about six a minute). */
export function coingecko(apiKey: string, fetchFn: typeof fetch = fetch): PriceSource {
  return {
    name: "CoinGecko",
    async get(tokens, until) {
      const bodies = await Promise.all(
        chunks(lower(tokens), 100).map((part) =>
          getJson("CoinGecko", fetchFn, until, `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${part.join(",")}&vs_currencies=usd`, {
            headers: { "x-cg-demo-api-key": apiKey },
          }, (b) => typeof b === "object" && b !== null && !Array.isArray(b)),
        ),
      );
      const out: Prices = new Map();
      for (const [token, quote] of bodies.flatMap((b) => Object.entries(b as Record<string, { usd?: unknown }>))) {
        const price = positive(quote?.usd);
        if (price !== undefined) out.set(token.toLowerCase() as Address, price);
      }
      return out;
    },
  };
}

/**
 * Every source is asked for every token, in parallel. A token's price is the median of three quotes, the lower of two
 * (overpricing a bribe would draw votes to it), or the only one; quotes more than SPREAD apart are logged. A failed
 * source is logged and left out; fails only if every source does.
 */
export function combined(sources: PriceSource[]): PriceSource {
  return {
    name: "combined",
    async get(tokens, until) {
      const distinct = lower(tokens);
      const settled = await Promise.allSettled(sources.map((s) => s.get(distinct, until)));
      settled.forEach((s, i) => s.status === "rejected" && log.warning("price source failed", { source: sources[i]!.name, reason: describe(s.reason) }));
      const maps = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      if (maps.length === 0) throw new Error(`no price source answered: ${settled.map((s) => (s.status === "rejected" ? describe(s.reason) : "")).join("; ")}`);
      const quotes = (t: Address) => maps.flatMap((m) => (m.has(t) ? [m.get(t)!] : []));
      const out: Prices = new Map();
      for (const t of distinct) {
        const q = quotes(t).sort((a, b) => a - b);
        if (q.length === 0) continue;
        if (q.length > 1 && q.at(-1)! / q[0]! > SPREAD) log.warning("price sources disagree", { token: t, quotes: q });
        out.set(t, q.length >= 3 ? q[Math.floor(q.length / 2)]! : q[0]!);
      }
      return out;
    },
  };
}

/**
 * Fresh prices at every call, except that the last set stands in when every source fails, or when time is short and
 * it was asked for every token (a reward token new since then is fetched). Tokens the set lacks are then unpriced,
 * which the caller counts as zero, rather than failing the pass.
 */
export function priceFeed(source: PriceSource) {
  let cached: { at: number; asked: Set<Address>; map: Prices } | undefined;
  return async (tokens: Address[], until = Infinity): Promise<Prices> => {
    const distinct = lower(tokens);
    if (cached && until - Date.now() < REFRESH_BUDGET && distinct.every((t) => cached!.asked.has(t))) return cached.map;
    try {
      cached = { at: Date.now(), asked: new Set(distinct), map: await source.get(distinct, until) };
    } catch (error) {
      if (!cached) throw error;
      log.warning("using cached prices", { ageMs: Date.now() - cached.at, reason: describe(error) });
    }
    return cached.map;
  };
}

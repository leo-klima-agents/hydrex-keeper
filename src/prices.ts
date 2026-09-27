import { setTimeout as sleep } from "node:timers/promises";
import type { Address } from "viem";
import { describe, log } from "./log.ts";

const ENDPOINT = "https://coins.llama.fi/prices/current/";
const CHUNK = 50;
const ATTEMPTS = 3;
const TIMEOUT = 15_000;
const REFRESH_BUDGET = 20_000; // ms before `until` under which the last set is reused

type LlamaPrices = { coins: Record<string, { price: number }> };

/** USD prices by lowercase address; tokens DefiLlama does not know are absent. `until` (ms) bounds retries and timeouts. */
export async function prices(tokens: Address[], fetchFn: typeof fetch = fetch, until = Infinity): Promise<Map<Address, number>> {
  const out = new Map<Address, number>();
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const chunk = distinct.slice(i, i + CHUNK);
    const body = await getJson(ENDPOINT + chunk.map((t) => `base:${t}`).join(","), fetchFn, until);
    for (const [key, coin] of Object.entries(body.coins)) {
      const token = key.slice("base:".length).toLowerCase() as Address;
      if (chunk.includes(token) && Number.isFinite(coin.price) && coin.price > 0) out.set(token, coin.price);
    }
  }
  return out;
}

async function getJson(url: string, fetchFn: typeof fetch, until: number): Promise<LlamaPrices> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await sleep(delay);
    }
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT, until - Date.now()))) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Partial<LlamaPrices> | null;
      if (!body || typeof body.coins !== "object" || body.coins === null) throw new Error("malformed response");
      return body as LlamaPrices;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DefiLlama unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Fetches at every call, but reuses the last set under REFRESH_BUDGET if it covers every token, or if the fetch fails. */
export function priceFeed(fetchFn: typeof fetch = fetch): (tokens: Address[], until?: number) => Promise<Map<Address, number>> {
  let last: { at: number; requested: Set<Address>; map: Map<Address, number> } | undefined;
  return async (tokens, until = Infinity) => {
    const requested = tokens.map((t) => t.toLowerCase() as Address);
    if (last && until - Date.now() < REFRESH_BUDGET && requested.every((t) => last!.requested.has(t))) return last.map;
    try {
      last = { at: Date.now(), requested: new Set(requested), map: await prices(tokens, fetchFn, until) };
    } catch (error) {
      if (!last) throw error;
      log.warning("using the last prices", { ageMs: Date.now() - last.at, reason: describe(error) });
    }
    return last.map;
  };
}

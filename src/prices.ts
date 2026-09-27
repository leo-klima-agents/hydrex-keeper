import type { Address } from "viem";
import { describe, log } from "./log.ts";

// USD prices from DefiLlama. Tokens it does not know are absent from the result.
const ENDPOINT = "https://coins.llama.fi/prices/current/";
const CHUNK = 50;
const ATTEMPTS = 3;
const TIMEOUT = 15_000;
const REFRESH_BUDGET = 20_000; // ms left before `until` under which a cached set is served rather than refreshed

type Response = { coins: Record<string, { price: number }> };

/** `until` (ms) bounds the time spent on retries and timeouts. */
export async function prices(tokens: Address[], fetchFn: typeof fetch = fetch, until = Infinity): Promise<Map<Address, number>> {
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  const chunks = Array.from({ length: Math.ceil(distinct.length / CHUNK) }, (_, i) => distinct.slice(i * CHUNK, (i + 1) * CHUNK));
  const bodies = await Promise.all(chunks.map((chunk) => getJson(ENDPOINT + chunk.map((t) => `base:${t}`).join(","), fetchFn, until)));
  const out = new Map<Address, number>();
  for (const [i, body] of bodies.entries()) {
    for (const [key, coin] of Object.entries(body.coins)) {
      const token = key.slice("base:".length).toLowerCase() as Address;
      if (chunks[i]!.includes(token) && Number.isFinite(coin.price) && coin.price > 0) out.set(token, coin.price);
    }
  }
  return out;
}

async function getJson(url: string, fetchFn: typeof fetch, until: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT, until - Date.now()))) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Partial<Response> | null;
      if (!body || typeof body.coins !== "object" || body.coins === null) throw new Error("malformed response");
      return body as Response;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DefiLlama unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Fresh prices at every call, except that the last set stands in when time is short or DefiLlama fails. Tokens
 * that set lacks are then unpriced, which the caller counts as zero, rather than failing the pass.
 */
export function priceFeed(fetchFn: typeof fetch = fetch) {
  let cached: { at: number; map: Map<Address, number> } | undefined;
  return async (tokens: Address[], until = Infinity): Promise<Map<Address, number>> => {
    if (cached && until - Date.now() < REFRESH_BUDGET) return cached.map;
    try {
      cached = { at: Date.now(), map: await prices(tokens, fetchFn, until) };
    } catch (error) {
      if (!cached) throw error;
      log.warning("using cached prices", { ageMs: Date.now() - cached.at, reason: describe(error) });
    }
    return cached.map;
  };
}

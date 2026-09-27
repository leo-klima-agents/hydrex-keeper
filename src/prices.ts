import { setTimeout as sleep } from "node:timers/promises";
import type { Address } from "viem";
import { errorMessage, log } from "./log.ts";

// USD prices from DefiLlama. Tokens it does not know are absent from the result.
const ENDPOINT = "https://coins.llama.fi/prices/current/";
const CHUNK = 50;
const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;
const REFRESH_BUDGET_MS = 20_000; // with less time left before `until`, the last set is served instead

type LlamaResponse = { coins: Record<string, { price: number }> };

/** `until` (ms) bounds the time spent on retries and timeouts. */
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

async function getJson(url: string, fetchFn: typeof fetch, until: number): Promise<LlamaResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await sleep(delay);
    }
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, until - Date.now()))) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Partial<LlamaResponse> | null;
      if (!body || typeof body.coins !== "object" || body.coins === null) throw new Error("malformed response");
      return body as LlamaResponse;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DefiLlama unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Refreshes at every call that has time for it; serves the last set when there is none or the refresh fails. */
export function priceFeed(fetchFn: typeof fetch = fetch) {
  let cached: { at: number; requested: Set<Address>; map: Map<Address, number> } | undefined;
  return async (tokens: Address[], until = Infinity): Promise<Map<Address, number>> => {
    const requested = tokens.map((t) => t.toLowerCase() as Address);
    const covered = cached !== undefined && requested.every((t) => cached!.requested.has(t));
    if (covered && until - Date.now() < REFRESH_BUDGET_MS) return cached!.map;
    try {
      cached = { at: Date.now(), requested: new Set(requested), map: await prices(tokens, fetchFn, until) };
    } catch (error) {
      if (!covered) throw error;
      log.warning("using cached prices", { ageMs: Date.now() - cached!.at, reason: errorMessage(error) });
    }
    return cached!.map;
  };
}

import type { Address } from "viem";

// USD prices from DefiLlama. Tokens it does not know are absent from the result.
const ENDPOINT = "https://coins.llama.fi/prices/current/";
const CHUNK = 50;
const ATTEMPTS = 3;

type Response = { coins: Record<string, { price: number }> };

export async function prices(tokens: Address[], fetchFn: typeof fetch = fetch): Promise<Map<Address, number>> {
  const out = new Map<Address, number>();
  const distinct = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const chunk = distinct.slice(i, i + CHUNK);
    const body = await getJson(ENDPOINT + chunk.map((t) => `base:${t}`).join(","), fetchFn);
    for (const [key, coin] of Object.entries(body.coins)) {
      const token = key.slice("base:".length).toLowerCase() as Address;
      if (chunk.includes(token) && Number.isFinite(coin.price) && coin.price > 0) out.set(token, coin.price);
    }
  }
  return out;
}

async function getJson(url: string, fetchFn: typeof fetch): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as Response;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DefiLlama unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

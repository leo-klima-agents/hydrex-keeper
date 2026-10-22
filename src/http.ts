import { setTimeout as sleep } from "node:timers/promises";

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

export const isObject = (body: unknown): body is Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

/**
 * Retries until `until` (ms). An error returned by `final` is thrown at once, without retrying. Errors name the service
 * but never the URL, because some URLs contain an API key.
 */
export async function getJson(
  name: string,
  url: string,
  init: RequestInit,
  valid: (body: unknown) => boolean,
  fetchFn: typeof fetch,
  until: number,
  final?: (status: number, body: unknown) => Error | undefined,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await sleep(delay);
    }
    let answer: { status: number; ok: boolean; body: unknown };
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, until - Date.now())));
      const response = await fetchFn(url, { ...init, signal });
      answer = { status: response.status, ok: response.ok, body: await response.json().catch(() => undefined) };
    } catch (error) {
      lastError = error;
      continue;
    }
    const refused = final?.(answer.status, answer.body);
    if (refused) throw refused;
    if (answer.ok && valid(answer.body)) return answer.body;
    lastError = new Error(answer.ok ? "malformed response" : `HTTP ${answer.status}`);
  }
  throw new Error(`${name} unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

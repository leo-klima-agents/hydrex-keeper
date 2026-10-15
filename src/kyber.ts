import { setTimeout as sleep } from "node:timers/promises";
import { decodeFunctionData, getAddress, isAddress, isAddressEqual, isHex, type Address, type Hex } from "viem";
import { kyberAbi } from "./abi.ts";
import { errorMessage } from "./log.ts";

const API = "https://aggregator-api.kyberswap.com/base/api/v1";
const CLIENT_ID = "hydrex-keeper";
const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

export type SwapRequest = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Pays `tokenIn` and receives `tokenOut`. */
  account: Address;
  slippageBps: number;
};

/** Calldata for `router` that sells exactly `amountIn` and pays at least `minOut`; `amountOut` is the quote. */
export type Swap = { router: Address; data: Hex; amountIn: bigint; amountOut: bigint; minOut: bigint };

/** Builds a swap; `until` (ms) bounds retries and timeouts. */
export type Swapper = (request: SwapRequest, until: number) => Promise<Swap>;

/** Refused by KyberSwap, for instance for want of a route: asking again would not help. */
export class SwapRefused extends Error {}

/** KyberSwap answered with something else than the swap asked for: a change on its side, or worse. */
export class BadSwap extends Error {}

const isObject = (body: unknown): body is Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

/**
 * KyberSwap's aggregator: a route, then its calldata, for a swap paid from and to `account`. The calldata is decoded
 * and must sell exactly the amount and token asked for, for the token asked for, to `account`.
 */
export function kyberswap(fetchFn: typeof fetch = fetch): Swapper {
  return async ({ tokenIn, tokenOut, amountIn, account, slippageBps }, until) => {
    const query = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn) });
    const { routeSummary } = await kyber(`${API}/routes?${query}`, undefined, fetchFn, until);
    if (!isObject(routeSummary)) throw new BadSwap("KyberSwap: malformed route");
    const body = JSON.stringify({
      routeSummary,
      sender: account,
      recipient: account,
      slippageTolerance: slippageBps,
      source: CLIENT_ID,
    });
    const built = await kyber(`${API}/route/build`, body, fetchFn, until);
    const { routerAddress, data, amountOut } = built;
    if (typeof routerAddress !== "string" || !isAddress(routerAddress) || typeof data !== "string" || !isHex(data)) {
      throw new BadSwap("KyberSwap: malformed calldata");
    }
    let desc;
    try {
      desc = decodeFunctionData({ abi: kyberAbi, data }).args[0].desc;
    } catch (error) {
      throw new BadSwap(`KyberSwap: calldata is not a swap: ${errorMessage(error)}`);
    }
    const asked =
      isAddressEqual(desc.srcToken, tokenIn) &&
      isAddressEqual(desc.dstToken, tokenOut) &&
      isAddressEqual(desc.dstReceiver, account) &&
      desc.amount === amountIn;
    if (!asked) {
      const got = `${desc.amount} of ${desc.srcToken} for ${desc.dstToken} to ${desc.dstReceiver}`;
      throw new BadSwap(`KyberSwap built another swap: ${got}`);
    }
    const quoted = typeof amountOut === "string" && /^\d+$/.test(amountOut) ? BigInt(amountOut) : desc.minReturnAmount;
    return { router: getAddress(routerAddress), data, amountIn, amountOut: quoted, minOut: desc.minReturnAmount };
  };
}

/**
 * The `data` of a KyberSwap answer to a GET, or to a POST of `body`. Retried with backoff while there is time; an
 * error code in an answer that is not a server error or a rate limit is final.
 */
async function kyber(
  url: string,
  body: string | undefined,
  fetchFn: typeof fetch,
  until: number,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (until - Date.now() < delay + 1000) break;
      await sleep(delay);
    }
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, until - Date.now())));
      const headers = { "x-client-id": CLIENT_ID, "content-type": "application/json" };
      const response = await fetchFn(url, { headers, signal, ...(body ? { method: "POST", body } : {}) });
      const answer: unknown = await response.json().catch(() => undefined);
      const code = isObject(answer) ? answer.code : undefined;
      if (typeof code === "number" && code !== 0 && response.status < 500 && response.status !== 429) {
        const message = isObject(answer) && typeof answer.message === "string" ? answer.message : `code ${code}`;
        throw new SwapRefused(`KyberSwap: ${message}`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!isObject(answer) || !isObject(answer.data)) throw new Error("malformed response");
      return answer.data;
    } catch (error) {
      if (error instanceof SwapRefused) throw error;
      lastError = error;
    }
  }
  throw new Error(`KyberSwap unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

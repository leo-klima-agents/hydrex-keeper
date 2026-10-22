import { decodeFunctionData, getAddress, isAddress, isAddressEqual, isHex, type Address, type Hex } from "viem";
import { kyberAbi } from "./abi.ts";
import { getJson, isObject } from "./http.ts";
import { errorMessage } from "./log.ts";

const API = "https://aggregator-api.kyberswap.com/base/api/v1";
const CLIENT_ID = "hydrex-keeper";

export type SwapRequest = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  account: Address;
  slippageBps: number;
};

export type Swap = { router: Address; data: Hex; amountIn: bigint; amountOut: bigint; minOut: bigint };

export type Swapper = (request: SwapRequest, until: number) => Promise<Swap>;

/** KyberSwap said no, for example because it found no route. Retrying won't help. */
export class SwapRefused extends Error {}

export class BadSwap extends Error {}

export function kyberswap(fetchFn: typeof fetch = fetch): Swapper {
  return async ({ tokenIn, tokenOut, amountIn, account, slippageBps }, until) => {
    const query = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn) });
    const { routeSummary } = await kyber(`${API}/routes?${query}`, {}, fetchFn, until);
    if (!isObject(routeSummary)) throw new BadSwap("KyberSwap: malformed route");
    const body = JSON.stringify({
      routeSummary,
      sender: account,
      recipient: account,
      slippageTolerance: slippageBps,
      source: CLIENT_ID,
    });
    const built = await kyber(`${API}/route/build`, { method: "POST", body }, fetchFn, until);
    const { routerAddress, data, amountOut } = built;
    if (typeof routerAddress !== "string" || !isAddress(routerAddress) || typeof data !== "string" || !isHex(data)) {
      throw new BadSwap("KyberSwap: malformed calldata");
    }
    let desc;
    try {
      const decoded = decodeFunctionData({ abi: kyberAbi, data });
      desc = decoded.functionName === "swapSimpleMode" ? decoded.args[1] : decoded.args[0].desc;
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

async function kyber(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  until: number,
): Promise<Record<string, unknown>> {
  const headers = { "x-client-id": CLIENT_ID, "content-type": "application/json" };
  const valid = (body: unknown) => isObject(body) && isObject(body.data);
  const refused = (status: number, body: unknown) => {
    const code = isObject(body) ? body.code : undefined;
    if (typeof code !== "number" || code === 0 || status >= 500 || status === 429) return undefined;
    const message = isObject(body) && typeof body.message === "string" ? body.message : `code ${code}`;
    return new SwapRefused(`KyberSwap: ${message}`);
  };
  const answer = await getJson("KyberSwap", url, { ...init, headers }, valid, fetchFn, until, refused);
  return (answer as { data: Record<string, unknown> }).data;
}

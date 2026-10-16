import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { kyberAbi } from "../src/abi.ts";
import { kyberswap, SwapRefused } from "../src/kyber.ts";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KVCM: Address = "0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d";
const CONDUIT: Address = "0xdE91885cF35ac57DF0c4A75c16862127dBe8317c";
const ROUTER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
const EXECUTOR: Address = "0x8F10B468b06c6FD214B65F87778827F7D113f996";

const request = { tokenIn: USDC, tokenOut: KVCM, amountIn: 10_000_000n, account: CONDUIT, slippageBps: 500 };

type Swap = { srcToken?: Address; dstToken?: Address; dstReceiver?: Address; amount?: bigint; minReturn?: bigint };

type Entry = "swap" | "swapGeneric" | "swapSimpleMode";

function calldata(
  { srcToken = USDC, dstToken = KVCM, dstReceiver = CONDUIT, amount = 10_000_000n, minReturn }: Swap,
  entry: Entry = "swap",
) {
  const desc = {
    srcToken,
    dstToken,
    srcReceivers: [EXECUTOR],
    srcAmounts: [amount],
    feeReceivers: [],
    feeAmounts: [],
    dstReceiver,
    amount,
    minReturnAmount: minReturn ?? 350n * 10n ** 18n,
    flags: 512n,
    permit: "0x",
  } as const;
  const execution = {
    callTarget: EXECUTOR,
    approveTarget: EXECUTOR,
    targetData: "0x",
    desc,
    clientData: "0x",
  } as const;
  if (entry === "swapSimpleMode") {
    return encodeFunctionData({ abi: kyberAbi, functionName: entry, args: [EXECUTOR, desc, "0x", "0x"] });
  }
  return encodeFunctionData({ abi: kyberAbi, functionName: entry, args: [execution] });
}

const route = { code: 0, message: "successfully", data: { routeSummary: { routeID: "r" }, routerAddress: ROUTER } };
const built = (swap: Swap = {}, entry?: Entry) => ({
  code: 0,
  message: "successfully",
  data: { routerAddress: ROUTER, data: calldata(swap, entry), amountOut: "374416742845163634687" },
});

function fakeFetch(responses: (() => Response)[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }) as typeof fetch;
  return { fetchFn, requests };
}

const far = () => Date.now() + 60_000;

test("asks for a route, then for calldata that swaps from and to the account, and returns its minimum", async () => {
  const { fetchFn, requests } = fakeFetch([() => Response.json(route), () => Response.json(built())]);
  const swap = await kyberswap(fetchFn)(request, far());
  assert.deepEqual(swap, {
    router: getAddress(ROUTER),
    data: calldata({}),
    amountIn: 10_000_000n,
    amountOut: 374_416_742_845_163_634_687n,
    minOut: 350n * 10n ** 18n,
  });
  const [get, post] = requests;
  assert.equal(
    get!.url,
    `https://aggregator-api.kyberswap.com/base/api/v1/routes?tokenIn=${USDC}&tokenOut=${KVCM}&amountIn=10000000`,
  );
  assert.equal((get!.init.headers as Record<string, string>)["x-client-id"], "hydrex-keeper");
  assert.equal(post!.url, "https://aggregator-api.kyberswap.com/base/api/v1/route/build");
  assert.equal(post!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(post!.init.body)), {
    routeSummary: { routeID: "r" },
    sender: CONDUIT,
    recipient: CONDUIT,
    slippageTolerance: 500,
    source: "hydrex-keeper",
  });
});

test("calldata that would sell or buy anything else, or pay anyone else, is refused", async () => {
  for (const swap of [
    { srcToken: KVCM },
    { dstToken: USDC },
    { dstReceiver: EXECUTOR },
    { amount: 10_000_001n },
  ] satisfies Swap[]) {
    const { fetchFn } = fakeFetch([() => Response.json(route), () => Response.json(built(swap))]);
    await assert.rejects(kyberswap(fetchFn)(request, far()), /KyberSwap built another swap/);
  }
});

test("calldata for the router's other entry points is checked the same way", async () => {
  for (const entry of ["swapGeneric", "swapSimpleMode"] as const) {
    const ok = fakeFetch([() => Response.json(route), () => Response.json(built({}, entry))]);
    assert.equal((await kyberswap(ok.fetchFn)(request, far())).minOut, 350n * 10n ** 18n, entry);
    const other = fakeFetch([() => Response.json(route), () => Response.json(built({ dstReceiver: EXECUTOR }, entry))]);
    await assert.rejects(kyberswap(other.fetchFn)(request, far()), /KyberSwap built another swap/);
  }
});

test("an answer with an error code is final; a server error or a rate limit is retried", async () => {
  const notFound = { code: 4008, message: "route not found" };
  const refused = fakeFetch([() => Response.json(notFound, { status: 400 })]);
  await assert.rejects(
    kyberswap(refused.fetchFn)(request, far()),
    (e) => e instanceof SwapRefused && e.message === "KyberSwap: route not found",
  );
  assert.equal(refused.requests.length, 1);
  const flaky = fakeFetch([
    () => new Response("busy", { status: 503 }),
    () => Response.json({ code: 4290, message: "rate limited" }, { status: 429 }),
    () => Response.json(route),
    () => Response.json(built()),
  ]);
  assert.equal((await kyberswap(flaky.fetchFn)(request, far())).minOut, 350n * 10n ** 18n);
  assert.equal(flaky.requests.length, 4);
});

test("gives up when every attempt fails, or when out of time to retry", async () => {
  const down = fakeFetch(Array.from({ length: 3 }, () => () => new Response("down", { status: 502 })));
  await assert.rejects(kyberswap(down.fetchFn)(request, far()), /^Error: KyberSwap unavailable: HTTP 502$/);
  const late = fakeFetch([() => Response.json({ data: "nope" })]);
  await assert.rejects(kyberswap(late.fetchFn)(request, Date.now() + 1_500), /KyberSwap unavailable: malformed/);
  assert.equal(late.requests.length, 1);
});

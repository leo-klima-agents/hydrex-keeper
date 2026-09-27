import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFeed, prices } from "../src/prices.ts";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const JUNK = "0x00000000000000000000000000000000000000ff";

function fakeFetch(responses: (() => Response)[]) {
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return responses.shift()!();
  }) as typeof fetch;
  return { fetchFn, urls };
}

test("prices known tokens by lowercase address, omits unknown ones", async () => {
  const { fetchFn, urls } = fakeFetch([
    () =>
      Response.json({
        coins: {
          [`base:${WETH}`]: { price: 2689.05, confidence: 0.99 },
          [`base:${USDC.toLowerCase()}`]: { price: 0.9999, confidence: 0.99 },
        },
      }),
  ]);
  const map = await prices([WETH, USDC, JUNK, WETH], fetchFn);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], `https://coins.llama.fi/prices/current/base:${WETH},base:${USDC.toLowerCase()},base:${JUNK}`);
  assert.equal(map.get(WETH), 2689.05);
  assert.equal(map.get(USDC.toLowerCase() as typeof USDC), 0.9999);
  assert.equal(map.has(JUNK), false);
});

test("splits requests into chunks of 50", async () => {
  const tokens = Array.from({ length: 120 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`);
  const { fetchFn, urls } = fakeFetch([() => Response.json({ coins: {} }), () => Response.json({ coins: {} }), () => Response.json({ coins: {} })]);
  await prices(tokens, fetchFn);
  assert.deepEqual(urls.map((u) => u.split(",").length), [50, 50, 20]);
});

test("retries on failure, then gives up", async () => {
  const { fetchFn } = fakeFetch([() => new Response("nope", { status: 500 }), () => Response.json({ coins: { [`base:${WETH}`]: { price: 1 } } })]);
  assert.equal((await prices([WETH], fetchFn)).get(WETH), 1);
  const failing = fakeFetch([() => new Response("", { status: 503 }), () => new Response("", { status: 503 }), () => new Response("", { status: 503 })]);
  await assert.rejects(prices([WETH], failing.fetchFn), /DefiLlama unavailable: HTTP 503/);
  assert.equal(failing.urls.length, 3);
});

test("priceFeed refreshes at every call, serves the last set when the refresh fails, fails on new tokens", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { fetchFn, urls } = fakeFetch([
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 1 } } }),
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 2 } } }),
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
  ]);
  const feed = priceFeed(fetchFn);
  assert.equal((await feed([WETH])).get(WETH), 1);
  assert.equal((await feed([WETH])).get(WETH), 2, "refreshed");
  assert.equal((await feed([WETH])).get(WETH), 2, "the last set is served when the refresh fails");
  assert.equal(urls.length, 5);
  await assert.rejects(feed([JUNK]), /DefiLlama unavailable/);
});

test("a malformed 200 response is retried", async () => {
  const { fetchFn, urls } = fakeFetch([() => Response.json({ message: "rate limited" }), () => Response.json({ coins: { [`base:${WETH}`]: { price: 4 } } })]);
  assert.equal((await prices([WETH], fetchFn)).get(WETH), 4);
  assert.equal(urls.length, 2);
});

test("priceFeed serves the last set when the deadline is near, unless a token is new", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { fetchFn, urls } = fakeFetch([
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 1 } } }),
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 2 }, [`base:${USDC.toLowerCase()}`]: { price: 1 } } }),
  ]);
  const feed = priceFeed(fetchFn);
  assert.equal((await feed([WETH], Date.now() + 60_000)).get(WETH), 1);
  assert.equal((await feed([WETH], Date.now() + 10_000)).get(WETH), 1, "10 s left: no refresh");
  assert.equal((await feed([WETH, USDC], Date.now() + 10_000)).get(WETH), 2, "a new token forces a refresh");
  assert.equal(urls.length, 2);
});

test("prices stops retrying when a retry cannot finish before the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { fetchFn, urls } = fakeFetch([() => new Response("", { status: 503 }), () => new Response("", { status: 503 })]);
  await assert.rejects(prices([WETH], fetchFn, Date.now() + 1_500), /DefiLlama unavailable/);
  assert.equal(urls.length, 1);
});

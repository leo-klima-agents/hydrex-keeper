import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { alchemy, coingecko, combined, defillama, priceFeed, type PriceSource } from "../src/prices.ts";

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

const prices = (tokens: string[], fetchFn: typeof fetch, until = Infinity) =>
  defillama(fetchFn).get(tokens as Address[], until);

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
  const { fetchFn, urls } = fakeFetch([
    () => Response.json({ coins: {} }),
    () => Response.json({ coins: {} }),
    () => Response.json({ coins: {} }),
  ]);
  await prices(tokens, fetchFn);
  assert.deepEqual(
    urls.map((u) => u.split(",").length),
    [50, 50, 20],
  );
});

test("retries on failure, then gives up", async () => {
  const { fetchFn } = fakeFetch([
    () => new Response("nope", { status: 500 }),
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 1 } } }),
  ]);
  assert.equal((await prices([WETH], fetchFn)).get(WETH), 1);
  const failing = fakeFetch([
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
  ]);
  await assert.rejects(prices([WETH], failing.fetchFn), /DefiLlama unavailable: HTTP 503/);
  assert.equal(failing.urls.length, 3);
});

test("priceFeed refreshes at every call with time and serves the last set near the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { fetchFn, urls } = fakeFetch([
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 1 } } }),
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 2 } } }),
  ]);
  const feed = priceFeed(defillama(fetchFn));
  assert.equal((await feed([WETH], Date.now() + 60_000)).get(WETH), 1);
  assert.equal((await feed([WETH], Date.now() + 60_000)).get(WETH), 2, "refreshed");
  assert.equal((await feed([WETH], Date.now() + 10_000)).get(WETH), 2, "10 s left: the last set");
  assert.equal(urls.length, 2);
});

test("priceFeed fetches a new token near the deadline and serves the last set when the fetch fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { fetchFn, urls } = fakeFetch([
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 1 } } }),
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 2 }, [`base:${USDC.toLowerCase()}`]: { price: 1 } } }),
    () => new Response("", { status: 503 }),
  ]);
  const feed = priceFeed(defillama(fetchFn));
  await feed([WETH], Date.now() + 60_000);
  assert.equal(
    (await feed([WETH, USDC], Date.now() + 5_000)).get(USDC.toLowerCase() as typeof USDC),
    1,
    "a new token forces a fetch",
  );
  const last = await feed([WETH, JUNK], Date.now() + 1_500);
  assert.deepEqual(
    [last.get(WETH), last.has(JUNK)],
    [2, false],
    "the fetch failed: the last set, the new token unpriced",
  );
  assert.equal(urls.length, 3);
  const empty = fakeFetch([() => new Response("", { status: 503 })]);
  await assert.rejects(
    priceFeed(defillama(empty.fetchFn))([WETH], Date.now() + 1_500),
    /DefiLlama unavailable/,
    "no last set",
  );
});

test("a malformed 200 response is retried", async () => {
  const { fetchFn, urls } = fakeFetch([
    () => Response.json({ message: "rate limited" }),
    () => Response.json({ coins: { [`base:${WETH}`]: { price: 4 } } }),
  ]);
  assert.equal((await prices([WETH], fetchFn)).get(WETH), 4);
  assert.equal(urls.length, 2);
});

test("prices stops retrying when a retry cannot finish before the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { fetchFn, urls } = fakeFetch([
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
  ]);
  await assert.rejects(prices([WETH], fetchFn, Date.now() + 1_500), /DefiLlama unavailable/);
  assert.equal(urls.length, 1);
});

/** A source answering from a table, or failing; records what it was asked. */
function table(name: string, quotes: Record<string, number> | Error): PriceSource & { asked: Address[][] } {
  const asked: Address[][] = [];
  return {
    name,
    asked,
    get: async (tokens) => {
      asked.push(tokens);
      if (quotes instanceof Error) throw quotes;
      return new Map(tokens.flatMap((t) => (t in quotes ? [[t, quotes[t]!]] : [])));
    },
  };
}

const [T1, T2, T3, T4] = [1, 2, 3, 4].map((n) => `0x${n.toString(16).padStart(40, "0")}` as Address) as [
  Address,
  Address,
  Address,
  Address,
];

test("combined takes the median of three quotes, the lower of two, or the only one", async () => {
  const a = table("A", { [T1]: 1, [T2]: 2, [T3]: 10 });
  const b = table("B", { [T1]: 1.01, [T2]: 3, [T4]: 5 });
  const c = table("C", { [T2]: 2.5 });
  const source = combined([a, b, c]);
  assert.equal(source.name, "A+B+C");
  const out = await source.get([T1, T2, T3, T4], Infinity);
  assert.deepEqual(Object.fromEntries(out), { [T1]: 1, [T2]: 2.5, [T3]: 10, [T4]: 5 });
  assert.deepEqual([a.asked, b.asked, c.asked], [[[T1, T2, T3, T4]], [[T1, T2, T3, T4]], [[T1, T2, T3, T4]]]);
});

test("combined survives a failed source and fails only when every source does", async () => {
  const out = await combined([table("A", new Error("down")), table("B", { [T1]: 4 })]).get([T1], Infinity);
  assert.equal(out.get(T1), 4);
  await assert.rejects(
    combined([table("A", new Error("down")), table("B", new Error("out"))]).get([T1], Infinity),
    /no price source answered: Error: down; Error: out/,
  );
});

test("alchemy posts 25 addresses per request and reads USD values; errors do not show the key", async () => {
  const bodies: { addresses: { network: string; address: string }[] }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.g.alchemy.com/prices/v1/KEY/tokens/by-address");
    const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    bodies.push(body);
    const data = body.addresses.map((a, i) => ({
      ...a,
      prices: i === 0 ? [{ currency: "usd", value: "2.5", lastUpdatedAt: "2026-09-29T00:00:00Z" }] : [],
      error: i === 0 ? null : "Price not found",
    }));
    return Response.json({ data });
  }) as typeof fetch;
  const tokens = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
  const out = await alchemy("KEY", fetchFn).get(tokens, Infinity);
  assert.deepEqual(
    bodies.map((b) => b.addresses.length),
    [25, 5],
  );
  assert.equal(bodies[0]!.addresses[0]!.network, "base-mainnet");
  assert.deepEqual(Object.fromEntries(out), { [tokens[0]!]: 2.5, [tokens[25]!]: 2.5 });
  const failing = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    alchemy("SECRET-KEY", failing).get([T1], Date.now() + 1_500),
    (e: Error) => e.message === "Alchemy unavailable: HTTP 401",
  );
});

test("coingecko sends its demo key and 100 tokens per request", async () => {
  const requests: { url: URL; key: string | null }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    requests.push({ url: u, key: new Headers(init?.headers).get("x-cg-demo-api-key") });
    const [first] = u.searchParams.get("contract_addresses")!.split(",");
    return Response.json({ [first!]: { usd: 7 } });
  }) as typeof fetch;
  const tokens = Array.from({ length: 150 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
  const out = await coingecko("CG-KEY", fetchFn).get(tokens, Infinity);
  assert.deepEqual(
    requests.map((r) => r.url.searchParams.get("contract_addresses")!.split(",").length),
    [100, 50],
  );
  for (const { url, key } of requests) {
    assert.equal(url.origin + url.pathname, "https://api.coingecko.com/api/v3/simple/token_price/base");
    assert.equal(url.searchParams.get("vs_currencies"), "usd");
    assert.equal(key, "CG-KEY");
  }
  assert.deepEqual(Object.fromEntries(out), { [tokens[0]!]: 7, [tokens[100]!]: 7 });
});

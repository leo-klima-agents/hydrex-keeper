import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { keccak256, type Hex } from "viem";
import { base } from "viem/chains";
import { broadcaster, CHUNK, HEDGE_DELAY_MS, hedged, hostOf, readMany, type Call, type Client } from "../src/chain.ts";
import { errorMessage } from "../src/log.ts";

type Answer = { delay?: number; hang?: boolean; status?: number; error?: { code: number; message: string } };

/** A JSON-RPC server that answers every call with `result` after `delay` ms, or as told; records the params. */
async function rpc(result: (params: unknown[]) => unknown, answer: () => Answer = () => ({})) {
  const received: unknown[][] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const a = answer();
      const parsed = JSON.parse(body) as { id: number; params?: unknown[] } | { id: number; params?: unknown[] }[];
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      received.push(...calls.map((c) => c.params ?? []));
      if (a.hang) return;
      setTimeout(() => {
        if (a.status) return res.writeHead(a.status).end("unavailable");
        const reply = ({ id, params = [] }: { id: number; params?: unknown[] }) => ({
          jsonrpc: "2.0",
          id,
          ...(a.error ? { error: a.error } : { result: result(params) }),
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
      }, a.delay ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-key`;
  return { url, received, close: () => (server.closeAllConnections(), server.close()) };
}

const signed = "0x02f86c82210503808203e8830186a0940000000000000000000000000000000000000001808412345678c0" as Hex;
const accepts = () => rpc(([tx]) => keccak256(tx as Hex));
const refuses = (message: string) =>
  rpc(
    () => null,
    () => ({ error: { code: -32000, message } }),
  );

test("broadcast sends to every URL and resolves on the first acceptance, past a hung primary", async (t) => {
  const nodes = [
    await rpc(
      () => null,
      () => ({ hang: true }),
    ),
    await refuses("nonce too low"),
    await accepts(),
  ];
  t.after(() => nodes.forEach((n) => n.close()));
  const started = Date.now();
  assert.equal(await broadcaster(nodes.map((n) => n.url))(signed, Date.now() + 60_000), keccak256(signed));
  assert.ok(Date.now() - started < 1_000, "does not wait for the hung node");
  assert.deepEqual(
    nodes.map((n) => n.received),
    nodes.map(() => [[signed]]),
  );
});

test("broadcast counts 'already known' as accepted, and fails only when no node accepts", async (t) => {
  const nodes = [await refuses("already known"), await refuses("nonce too low"), await refuses("underpriced")];
  t.after(() => nodes.forEach((n) => n.close()));
  assert.equal(await broadcaster([nodes[0]!.url])(signed, Date.now() + 60_000), keccak256(signed));
  await assert.rejects(
    broadcaster(nodes.slice(1).map((n) => n.url))(signed, Date.now() + 60_000),
    (e: Error) =>
      /^no RPC accepted the vote: 127\.0\.0\.1:\d+: .*nonce too low.*; 127\.0\.0\.1:/s.test(e.message) &&
      !e.message.includes("secret-key"),
  );
});

test("logs name an RPC by its host only: provider URLs carry their key", () => {
  assert.equal(hostOf("https://base-mainnet.g.alchemy.com/v2/secret-key"), "base-mainnet.g.alchemy.com");
  assert.equal(hostOf("not a url"), "invalid URL");
});

const block = (n: number) => () => `0x${n.toString(16)}`;

/** Asks the URLs for the block number `calls` times in a row, timing each call. */
async function blockNumbers(nodes: { url: string }[], calls = 1) {
  const transport = hedged(nodes.map((n) => n.url))({ chain: base });
  const out: { result: unknown; ms: number }[] = [];
  for (let k = 0; k < calls; k++) {
    const t0 = Date.now();
    out.push({ result: await transport.request({ method: "eth_blockNumber" }), ms: Date.now() - t0 });
  }
  return out;
}

test("hedged: a healthy primary answers alone", async (t) => {
  const nodes = [await rpc(block(1)), await rpc(block(2))];
  t.after(() => nodes.forEach((n) => n.close()));
  assert.deepEqual(
    (await blockNumbers(nodes, 3)).map((r) => r.result),
    ["0x1", "0x1", "0x1"],
  );
  assert.equal(nodes[1]!.received.length, 0);
});

test("hedged: a slow primary is overtaken by the next URL, and wins if the next is slower still", async (t) => {
  const overtaken = [await rpc(block(1), () => ({ delay: 1_000 })), await rpc(block(2))];
  const winning = [
    await rpc(block(1), () => ({ delay: HEDGE_DELAY_MS + 100 })),
    await rpc(block(2), () => ({ delay: 2_000 })),
  ];
  t.after(() => [...overtaken, ...winning].forEach((n) => n.close()));
  const [a] = await blockNumbers(overtaken);
  assert.equal(a!.result, "0x2");
  assert.ok(a!.ms >= HEDGE_DELAY_MS && a!.ms < 600, `${a!.ms} ms`);
  const [b] = await blockNumbers(winning);
  assert.equal(b!.result, "0x1", "the primary's late answer");
  assert.ok(b!.ms < 600, `${b!.ms} ms`);
});

test("hedged: a hung primary costs the delay once, then is asked together with the next", async (t) => {
  const nodes = [await rpc(block(1), () => ({ hang: true })), await rpc(block(2))];
  t.after(() => nodes.forEach((n) => n.close()));
  const [first, second, third] = await blockNumbers(nodes, 3);
  assert.equal(first!.result, "0x2");
  assert.ok(first!.ms >= HEDGE_DELAY_MS, `${first!.ms} ms`);
  assert.ok(second!.ms < 100 && third!.ms < 100, `${second!.ms}, ${third!.ms} ms`);
  for (let i = 0; i < 50 && nodes[0]!.received.length < 3; i++) await sleep(10); // the hung node may see it last
  assert.equal(nodes[0]!.received.length, 3, "still asked, in case it recovers");
});

test("hedged: a failure asks the next URL at once; a revert is final; all failing rejects", async (t) => {
  const failing = [await rpc(block(1), () => ({ status: 503 })), await rpc(block(2))];
  const reverting = [await refuses("execution reverted: VoteDelayNotMet()"), await rpc(block(2))];
  const down = [await rpc(block(1), () => ({ status: 503 })), await rpc(block(2), () => ({ status: 502 }))];
  t.after(() => [...failing, ...reverting, ...down].forEach((n) => n.close()));
  const [a] = await blockNumbers(failing);
  assert.equal(a!.result, "0x2");
  assert.ok(a!.ms < HEDGE_DELAY_MS, `${a!.ms} ms`);
  await assert.rejects(blockNumbers(reverting), /execution reverted/);
  assert.equal(reverting[1]!.received.length, 0);
  await assert.rejects(blockNumbers(down), (e) => {
    const message = errorMessage(e);
    return /HTTP request failed/.test(message) && !message.includes("secret-key");
  });
});

test("readMany sends one multicall per CHUNK calls and keeps their order", async () => {
  const sizes: number[] = [];
  const client = {
    multicall: async ({ contracts, batchSize }: { contracts: Call[]; batchSize: number }) => {
      assert.equal(batchSize, 0, "viem does not split a chunk");
      sizes.push(contracts.length);
      return contracts.map((c) => c.args![0]);
    },
  } as unknown as Client;
  const calls = Array.from({ length: 2 * CHUNK + 1 }, (_, i) => ({
    address: "0x",
    abi: [],
    functionName: "f",
    args: [i],
  }));
  const results = await readMany<number>(client, calls as Call[]);
  assert.deepEqual(sizes, [CHUNK, CHUNK, 1]);
  assert.deepEqual(
    results,
    calls.map((_, i) => i),
  );
});

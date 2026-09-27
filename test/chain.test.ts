import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { keccak256, type Hex } from "viem";
import { base } from "viem/chains";
import { broadcaster, HEDGE_DELAY, hedged, hostOf } from "../src/chain.ts";

type Reply = "accept" | "known" | "reject" | "hang";

/** A JSON-RPC server answering eth_sendRawTransaction as told; records what it received. */
async function node(reply: Reply): Promise<{ url: string; received: string[]; server: Server }> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, params } = JSON.parse(body) as { id: number; params: string[] };
      received.push(params[0]!);
      if (reply === "hang") return;
      const error = { known: { code: -32000, message: "already known" }, reject: { code: -32000, message: "nonce too low" } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply === "accept" ? { jsonrpc: "2.0", id, result: keccak256(params[0] as Hex) } : { jsonrpc: "2.0", id, error: error[reply] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-key`, received, server };
}

const signed = "0x02f86c82210503808203e8830186a0940000000000000000000000000000000000000001808412345678c0" as Hex;

test("broadcast sends to every URL and resolves on the first acceptance, past a hanging primary", async () => {
  const nodes = await Promise.all([node("hang"), node("reject"), node("accept"), node("known")]);
  try {
    const started = Date.now();
    const hash = await broadcaster(nodes.map((n) => n.url))(signed, BigInt(Date.now() + 60_000));
    assert.equal(hash, keccak256(signed));
    assert.ok(Date.now() - started < 1_000, "does not wait for the hanging node");
    assert.deepEqual(nodes.map((n) => n.received), nodes.map(() => [signed]), "every node got it");
  } finally {
    for (const n of nodes) n.server.closeAllConnections(), n.server.close();
  }
});

test("broadcast counts 'already known' as accepted and fails only when no node accepts", async () => {
  const known = await node("known");
  const rejecting = await Promise.all([node("reject"), node("reject")]);
  try {
    assert.equal(await broadcaster([known.url])(signed, BigInt(Date.now() + 60_000)), keccak256(signed));
    await assert.rejects(broadcaster(rejecting.map((n) => n.url))(signed, BigInt(Date.now() + 60_000)), (e: Error) => /no RPC accepted/.test(e.message) && !e.message.includes("secret-key"));
  } finally {
    for (const n of [known, ...rejecting]) n.server.close();
  }
});

test("logs name RPCs by host only", () => {
  assert.equal(hostOf("https://snowy.base-mainnet.quiknode.pro/0123abcd/"), "snowy.base-mainnet.quiknode.pro");
  assert.equal(hostOf("not a url"), "invalid URL");
});

type Behaviour = { delay?: number; hang?: boolean; status?: number; error?: { code: number; message: string } };

/** A JSON-RPC server answering eth_blockNumber with `block` after `delay` ms, or as told; counts requests. */
async function rpc(block: number, behave: () => Behaviour = () => ({})) {
  const counter = { requests: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      counter.requests++;
      const b = behave();
      if (b.hang) return;
      setTimeout(() => {
        if (b.status) return res.writeHead(b.status).end("unavailable");
        const parsed = JSON.parse(body) as { id: number } | { id: number }[];
        const answer = ({ id }: { id: number }) => ({ jsonrpc: "2.0", id, ...(b.error ? { error: b.error } : { result: `0x${block.toString(16)}` }) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
      }, b.delay ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, counter, close: () => (server.closeAllConnections(), server.close()) };
}

async function timed(nodes: { url: string }[], calls = 1) {
  const transport = hedged(nodes.map((n) => n.url))({ chain: base });
  const out: { block: unknown; ms: number }[] = [];
  for (let k = 0; k < calls; k++) {
    const t0 = Date.now();
    out.push({ block: await transport.request({ method: "eth_blockNumber" }), ms: Date.now() - t0 });
  }
  return out;
}

test("hedged: a healthy primary answers alone", async (t) => {
  const nodes = [await rpc(1), await rpc(2)];
  t.after(() => nodes.forEach((n) => n.close()));
  assert.deepEqual((await timed(nodes, 3)).map((r) => r.block), ["0x1", "0x1", "0x1"]);
  assert.equal(nodes[1]!.counter.requests, 0);
});

test("hedged: a slow primary is overtaken by the next URL, and still wins if the next is slower", async (t) => {
  const overtaken = [await rpc(1, () => ({ delay: 1_000 })), await rpc(2)];
  const winning = [await rpc(1, () => ({ delay: HEDGE_DELAY + 100 })), await rpc(2, () => ({ delay: 2_000 }))];
  t.after(() => [...overtaken, ...winning].forEach((n) => n.close()));
  const [a] = await timed(overtaken);
  assert.equal(a!.block, "0x2");
  assert.ok(a!.ms >= HEDGE_DELAY && a!.ms < 600, `${a!.ms} ms`);
  const [b] = await timed(winning);
  assert.equal(b!.block, "0x1", "the primary's late answer is used");
  assert.ok(b!.ms < 600, `${b!.ms} ms`);
});

test("hedged: a hung primary costs the delay once, then is asked together with the next", async (t) => {
  const nodes = [await rpc(1, () => ({ hang: true })), await rpc(2)];
  t.after(() => nodes.forEach((n) => n.close()));
  const [first, second, third] = await timed(nodes, 3);
  assert.equal(first!.block, "0x2");
  assert.ok(first!.ms >= HEDGE_DELAY, `${first!.ms} ms`);
  assert.ok(second!.ms < 100 && third!.ms < 100, `${second!.ms}, ${third!.ms} ms`);
  assert.equal(nodes[0]!.counter.requests, 3, "still asked, in case it recovers");
});

test("hedged: a failure asks the next URL at once; a revert is final; all failing rejects", async (t) => {
  const failing = [await rpc(1, () => ({ status: 503 })), await rpc(2)];
  const reverting = [await rpc(1, () => ({ error: { code: 3, message: "execution reverted: VotedAlready()" } })), await rpc(2)];
  const down = [await rpc(1, () => ({ status: 503 })), await rpc(2, () => ({ status: 502 }))];
  t.after(() => [...failing, ...reverting, ...down].forEach((n) => n.close()));
  const [a] = await timed(failing);
  assert.equal(a!.block, "0x2");
  assert.ok(a!.ms < HEDGE_DELAY, `${a!.ms} ms`);
  await assert.rejects(timed(reverting), /execution reverted/);
  assert.equal(reverting[1]!.counter.requests, 0);
  await assert.rejects(timed(down), /HTTP request failed/);
});

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { keccak256, type Hex } from "viem";
import { broadcaster, hostOf } from "../src/chain.ts";

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

import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToBigInt, keccak256, numberToHex, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerializedEIP1559 } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { base } from "viem/chains";
import { derToSignature, kmsAccount, NoMetadataServer } from "../src/kms.ts";

const N = hexToBigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const KEY = "projects/p/locations/us/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";

function derInteger(value: bigint): number[] {
  const bytes = [...Buffer.from(numberToHex(value).slice(2).padStart(64, "0"), "hex")];
  while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return [0x02, bytes.length, ...bytes];
}

/** DER as KMS returns it. */
function der(r: bigint, s: bigint): Uint8Array {
  const body = [...derInteger(r), ...derInteger(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

const privateKey = generatePrivateKey();
const signer = privateKeyToAccount(privateKey);
const tx = { chainId: base.id, to: signer.address, nonce: 1, gas: 100_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, data: "0x1234" as Hex };

/** fetch stub: metadata token, then KMS signing with the local key in DER, high-s when asked. */
function fakeFetch(options: { highS?: boolean; metadata?: boolean } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).startsWith("http://metadata.google.internal/")) {
      if (options.metadata === false) throw new TypeError("fetch failed");
      assert.equal((init?.headers as Record<string, string>)["Metadata-Flavor"], "Google");
      return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
    }
    assert.equal(String(url), `https://cloudkms.googleapis.com/v1/${KEY}:asymmetricSign`);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer tok");
    const digest = Buffer.from((JSON.parse(String(init?.body)) as { digest: { sha256: string } }).digest.sha256, "base64");
    const sig = await sign({ hash: `0x${digest.toString("hex")}`, privateKey });
    let s = hexToBigInt(sig.s);
    if (options.highS) s = N - s;
    return Response.json({ signature: Buffer.from(der(hexToBigInt(sig.r), s)).toString("base64") });
  }) as typeof fetch;
  return { fetchFn, calls };
}

test("signs a transaction through KMS and the signature recovers to the keeper", async () => {
  const { fetchFn, calls } = fakeFetch();
  const account = kmsAccount(KEY, signer.address, fetchFn);
  const signed = (await account.signTransaction(tx)) as TransactionSerializedEIP1559;
  assert.equal(await recoverTransactionAddress({ serializedTransaction: signed }), signer.address);
  assert.equal(parseTransaction(signed).nonce, 1);
  assert.equal(signed, await signer.signTransaction(tx), "identical to a local signature");
  await account.signTransaction(tx);
  assert.equal(calls.filter((c) => c.startsWith("http://metadata")).length, 1, "token is cached");
});

test("normalizes a high-s signature", async () => {
  const { fetchFn } = fakeFetch({ highS: true });
  const account = kmsAccount(KEY, signer.address, fetchFn);
  const signed = await account.signTransaction(tx);
  assert.equal(signed, await signer.signTransaction(tx));
});

test("rejects a key that does not sign for the keeper", async () => {
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const hash = keccak256(serializeTransaction(tx));
  const sig = await sign({ hash, privateKey });
  await assert.rejects(derToSignature(der(hexToBigInt(sig.r), hexToBigInt(sig.s)), hash, other), /does not sign for/);
});

test("rejects malformed DER", async () => {
  await assert.rejects(derToSignature(Uint8Array.from([0x31, 0x00]), keccak256("0x"), signer.address), /not a DER/);
});

test("reports a missing metadata server distinctly", async () => {
  const { fetchFn } = fakeFetch({ metadata: false });
  const account = kmsAccount(KEY, signer.address, fetchFn);
  await assert.rejects(account.signTransaction(tx), NoMetadataServer);
});

import {
  bytesToBigInt,
  hexToBigInt,
  keccak256,
  numberToHex,
  recoverAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type LocalAccount,
  type Signature,
} from "viem";
import { toAccount } from "viem/accounts";

// Signs with a Cloud KMS secp256k1 key through the REST API, authenticated by
// the Cloud Run service account's metadata-server token.
const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const KMS_URL = "https://cloudkms.googleapis.com/v1/";
const SECP256K1_N = hexToBigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export class NoMetadataServer extends Error {}

export function kmsAccount(keyVersion: string, address: Address, fetchFn: typeof fetch = fetch): LocalAccount {
  let token: { value: string; expires: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expires) return token.value;
    let response: Response;
    try {
      response = await fetchFn(METADATA_URL, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new NoMetadataServer(`metadata server unreachable: ${String(error)}`);
    }
    if (!response.ok) throw new Error(`metadata server: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
    return token.value;
  }

  async function sign(hash: Hex): Promise<Signature> {
    const response = await fetchFn(`${KMS_URL}${keyVersion}:asymmetricSign`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ digest: { sha256: Buffer.from(hash.slice(2), "hex").toString("base64") } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`KMS asymmetricSign: HTTP ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { signature: string };
    return derToSignature(Buffer.from(body.signature, "base64"), hash, address);
  }

  return toAccount({
    address,
    async signTransaction(transaction, { serializer = serializeTransaction } = {}) {
      const signature = await sign(keccak256(await serializer(transaction)));
      return serializer(transaction, signature);
    },
    signMessage: () => Promise.reject(new Error("unsupported")),
    signTypedData: () => Promise.reject(new Error("unsupported")),
  });
}

/** DER SEQUENCE{INTEGER r, INTEGER s} -> low-s signature whose recovery id recovers `address`. */
export async function derToSignature(der: Uint8Array, hash: Hex, address: Address): Promise<Signature> {
  if (der[0] !== 0x30 || der[2] !== 0x02) throw new Error("KMS signature is not a DER sequence");
  const rLength = der[3]!;
  if (der[4 + rLength] !== 0x02) throw new Error("KMS signature is not a DER sequence");
  const sLength = der[5 + rLength]!;
  const r = bytesToBigInt(der.subarray(4, 4 + rLength));
  let s = bytesToBigInt(der.subarray(6 + rLength, 6 + rLength + sLength));
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
  for (const yParity of [0, 1]) {
    const signature: Signature = { r: numberToHex(r, { size: 32 }), s: numberToHex(s, { size: 32 }), yParity, v: BigInt(27 + yParity) };
    if ((await recoverAddress({ hash, signature })).toLowerCase() === address.toLowerCase()) return signature;
  }
  throw new Error(`KMS key does not sign for ${address}`);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { configOf, PUBLIC_RPCS } from "../src/config.ts";

const KEY = "projects/p/locations/global/keyRings/r/cryptoKeys";
const env = {
  MODULE: "0x750973e0cb728c3112561bc8e9b235afa9b17e81",
  KMS_KEY_VERSION: `${KEY}/keeper/cryptoKeyVersions/1`,
  CONDUIT: "0x692c323b425a9dfeebe302f56168a7798d93eac5",
  PROPOSER: "0x52c139f60452b93e1211f116bd43b28d7afc2bca",
  PROPOSER_KMS_KEY_VERSION: `${KEY}/proposer/cryptoKeyVersions/1`,
  BASE_RPC_URLS: "https://a.example/key, https://mainnet.base.org,",
};
const argv = ["node", "src/main.ts"];

test("the job's settings come from its arguments and environment, addresses checksummed", () => {
  assert.deepEqual(configOf(argv, env), {
    dryRun: false,
    immediately: false,
    claimNow: false,
    module: "0x750973E0CB728C3112561Bc8E9b235afA9B17E81",
    keyVersion: env.KMS_KEY_VERSION,
    immutable: {
      conduit: "0x692c323B425A9DfeebE302F56168a7798D93EAC5",
      proposer: "0x52c139f60452B93e1211F116BD43B28d7AfC2bCa",
    },
    proposerKeyVersion: env.PROPOSER_KMS_KEY_VERSION,
    rpcUrls: ["https://a.example/key", ...PUBLIC_RPCS],
  });
  const flags = configOf([...argv, "--dry-run", "--now"], env);
  assert.deepEqual([flags.dryRun, flags.immediately, flags.claimNow], [true, true, false]);
  assert.throws(() => configOf([...argv, "--now", "--claim"], env), /--now and --claim exclude each other/);
});

test("every setting the job needs must be set, and only a dry run goes without the KMS keys", () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => configOf(argv, { ...env, [name]: "" }), new RegExp(`^Error: ${name} is not set$`), name);
  }
  const dry = configOf([...argv, "--dry-run"], { ...env, KMS_KEY_VERSION: "", PROPOSER_KMS_KEY_VERSION: undefined });
  assert.deepEqual([dry.keyVersion, dry.proposerKeyVersion], [undefined, undefined]);
  assert.throws(() => configOf([...argv, "--dry-run"], { ...env, CONDUIT: undefined }), /CONDUIT is not set/);
  assert.throws(() => configOf(argv, { ...env, PROPOSER: "0x52c1" }), /PROPOSER is not an address: 0x52c1/);
});

test("the proposer needs a key of its own, whatever version of the keeper's it names", () => {
  const sameKey = { ...env, PROPOSER_KMS_KEY_VERSION: `${KEY}/keeper/cryptoKeyVersions/2` };
  assert.throws(() => configOf(argv, sameKey), /the proposer needs its own key, not the keeper's/);
  assert.throws(() => configOf([...argv, "--dry-run"], sameKey), /its own key/, "in a dry run too");
});

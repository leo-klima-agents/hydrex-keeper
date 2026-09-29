import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseWhitelist } from "../src/whitelist.ts";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("pools.json parses: every pool once, with a name", () => {
  const whitelist = parseWhitelist(readFileSync(new URL("../pools.json", import.meta.url), "utf8"));
  assert.ok(whitelist.every((w) => w.name.length > 0));
});

test("a pool listed twice, in any case, or an empty list is refused", () => {
  const twice = JSON.stringify([
    { pool: USDC, name: "a" },
    { pool: USDC.toLowerCase(), name: "b" },
  ]);
  assert.throws(() => parseWhitelist(twice), new RegExp(`lists ${USDC} more than once`));
  assert.throws(() => parseWhitelist("[]"), /empty/);
  assert.throws(
    () => parseWhitelist(JSON.stringify([{ pool: "0x1234", name: "short" }])),
    /Address "0x1234" is invalid/,
  );
});

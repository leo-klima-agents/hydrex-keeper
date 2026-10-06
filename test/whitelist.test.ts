import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseWhitelist } from "../src/whitelist.ts";

test("tokens.json parses: every token once, with a name", () => {
  const whitelist = parseWhitelist(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));
  assert.ok(whitelist.every((w) => w.name.length > 0));
  assert.equal(new Set(whitelist.map((w) => w.token)).size, whitelist.length);
});

test("an empty list or a malformed address is refused", () => {
  assert.throws(() => parseWhitelist("[]"), /empty/);
  assert.throws(
    () => parseWhitelist(JSON.stringify([{ token: "0x1234", name: "short" }])),
    /Address "0x1234" is invalid/,
  );
});

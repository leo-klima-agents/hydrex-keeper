import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  zeroAddress,
  type Abi,
} from "viem";
import { immutableAbi } from "../src/abi.ts";
import { errorKind, errorMessage, warnOnce } from "../src/log.ts";

const reverted = (abi: Abi, data: `0x${string}`) =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, data, functionName: "vote" }), {
    abi,
    args: [[], []],
    functionName: "vote",
    contractAddress: zeroAddress,
  });

test("a revert's message names the custom error and its arguments", () => {
  const data = encodeErrorResult({ abi: immutableAbi, errorName: "NotBetter", args: [5n, 6n] });
  assert.equal(
    errorMessage(reverted(immutableAbi, data)),
    'ContractFunctionExecutionError: The contract function "vote" reverted. NotBetter(5, 6)',
  );
  const reason = encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
    errorName: "Error",
    args: ["no"],
  });
  assert.match(errorMessage(reverted(immutableAbi, reason)), /reason:\nno$/, "a reason string, once");
});

test("warnOnce logs each distinct error once", (t) => {
  const write = t.mock.method(process.stdout, "write", () => true);
  const unread = warnOnce("values unread", { conduit: zeroAddress });
  assert.equal(unread(new Error("timeout")), undefined);
  unread(new Error("timeout"));
  unread(new Error("rate limited"));
  assert.equal(write.mock.callCount(), 2);
  const data = (a: bigint, b: bigint) => encodeErrorResult({ abi: immutableAbi, errorName: "NotBetter", args: [a, b] });
  unread(reverted(immutableAbi, data(5n, 6n)));
  unread(reverted(immutableAbi, data(7n, 9n)));
  assert.equal(write.mock.callCount(), 3, "the same error with other scores");
  assert.match(String(write.mock.calls[2]!.arguments[0]), /NotBetter\(5, 6\)/, "logged with its numbers");
});

test("an error's kind leaves out its numbers", () => {
  const kind = (old: bigint) =>
    errorKind(
      reverted(immutableAbi, encodeErrorResult({ abi: immutableAbi, errorName: "NotBetter", args: [old, 9n] })),
    );
  assert.equal(kind(5n), kind(70n));
  assert.notEqual(errorKind(new Error("timeout")), errorKind(new Error("rate limited")));
});

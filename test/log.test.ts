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
import { errorMessage, warnOnce } from "../src/log.ts";

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
});

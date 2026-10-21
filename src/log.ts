import { BaseError, ContractFunctionRevertedError } from "viem";

// JSON lines on stdout; Cloud Logging reads `severity` and `message`.
type Fields = Record<string, unknown>;

const bigints = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function emit(severity: "INFO" | "WARNING" | "ERROR", message: string, fields: Fields): void {
  process.stdout.write(JSON.stringify({ severity, message, ...fields }, bigints) + "\n");
}

export const log = {
  info: (message: string, fields: Fields = {}) => emit("INFO", message, fields),
  warning: (message: string, fields: Fields = {}) => emit("WARNING", message, fields),
  error: (message: string, fields: Fields = {}) => emit("ERROR", message, fields),
};

/** The error's name and short message, with the custom error a contract reverted with, which viem leaves out of both. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const { name, shortMessage, details } = error as Error & { shortMessage?: string; details?: string };
    const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    const data = reverted instanceof ContractFunctionRevertedError ? reverted.data : undefined;
    // Error(string) and Panic(uint256) are in the short message already.
    const custom = data && !["Error", "Panic"].includes(data.errorName) ? data : undefined;
    const why = custom ? ` ${custom.errorName}(${(custom.args ?? []).map(String).join(", ")})` : "";
    if (shortMessage) return `${name}: ${shortMessage}${why}${details ? ` (${details})` : ""}`;
    return `${name}: ${error.message}${why}`;
  }
  return String(error);
}

/** `errorMessage` without its numbers: an error that recurs with other scores, amounts or blocks is of the same kind. */
export const errorKind = (error: unknown) => errorMessage(error).replace(/\d+/g, "#");

/** A handler for errors that logs `message` once for each kind of error, and gives undefined. */
export function warnOnce(message: string, fields: Fields = {}): (error: unknown) => undefined {
  const seen = new Set<string>();
  return (error) => {
    const kind = errorKind(error);
    if (!seen.has(kind)) log.warning(message, { ...fields, error: errorMessage(error) });
    seen.add(kind);
    return undefined;
  };
}

import { BaseError, ContractFunctionRevertedError } from "viem";

// Cloud Logging reads `severity` and `message` from each JSON line.
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

/** The error's message, plus the custom error a contract reverted with, which viem leaves out. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const { name, shortMessage, details } = error as Error & { shortMessage?: string; details?: string };
    const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    const data = reverted instanceof ContractFunctionRevertedError ? reverted.data : undefined;
    // viem already includes Error(string) and Panic(uint256) reasons in the short message.
    const custom = data && !["Error", "Panic"].includes(data.errorName) ? data : undefined;
    const why = custom ? ` ${custom.errorName}(${(custom.args ?? []).map(String).join(", ")})` : "";
    if (shortMessage) return `${name}: ${shortMessage}${why}${details ? ` (${details})` : ""}`;
    return `${name}: ${error.message}${why}`;
  }
  return String(error);
}

export const errorKind = (error: unknown) => errorMessage(error).replace(/\d+/g, "#");

export function warnOnce(message: string, fields: Fields = {}): (error: unknown) => undefined {
  const seen = new Set<string>();
  return (error) => {
    const kind = errorKind(error);
    if (!seen.has(kind)) log.warning(message, { ...fields, error: errorMessage(error) });
    seen.add(kind);
    return undefined;
  };
}

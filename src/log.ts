// JSON lines on stdout; Cloud Logging reads `severity` and `message`.
type Fields = Record<string, unknown>;

function emit(severity: "INFO" | "WARNING" | "ERROR", message: string, fields: Fields): void {
  const json = JSON.stringify({ severity, message, ...fields }, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  process.stdout.write(json + "\n");
}

export const log = {
  info: (message: string, fields: Fields = {}) => emit("INFO", message, fields),
  warning: (message: string, fields: Fields = {}) => emit("WARNING", message, fields),
  error: (message: string, fields: Fields = {}) => emit("ERROR", message, fields),
};

/** One line for an error; viem errors carry a short message and details. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const { name, shortMessage, details } = error as Error & { shortMessage?: string; details?: string };
    if (shortMessage) return `${name}: ${shortMessage}${details ? ` (${details})` : ""}`;
    return `${name}: ${error.message}`;
  }
  return String(error);
}

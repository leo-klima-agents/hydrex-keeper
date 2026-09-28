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

export function describe(error: unknown): string {
  if (error instanceof Error) {
    const { name, shortMessage, details } = error as Error & { shortMessage?: string; details?: string };
    if (shortMessage) return `${name}: ${shortMessage}${details ? ` (${details})` : ""}`;
    return `${name}: ${error.message}`;
  }
  return String(error);
}

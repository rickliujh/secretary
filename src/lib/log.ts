/**
 * App logging. Every message passes through `redact` before it leaves the
 * webview, so secrets never reach the log file (design.md section 9).
 */
import { isTauri } from "@tauri-apps/api/core";
import { redact } from "./redact";

type Level = "error" | "warn" | "info" | "debug";

async function write(level: Level, message: string): Promise<void> {
  const safe = redact(message);
  if (!isTauri()) {
    console[level](safe);
    return;
  }
  const log = await import("@tauri-apps/plugin-log");
  await log[level](safe);
}

function format(message: string, detail?: unknown): string {
  if (detail === undefined) return message;
  if (detail instanceof Error) return `${message}: ${detail.name}: ${detail.message}`;
  try {
    return `${message}: ${JSON.stringify(detail)}`;
  } catch {
    return `${message}: ${String(detail)}`;
  }
}

export const logger = {
  error: (message: string, detail?: unknown) => void write("error", format(message, detail)),
  warn: (message: string, detail?: unknown) => void write("warn", format(message, detail)),
  info: (message: string, detail?: unknown) => void write("info", format(message, detail)),
  debug: (message: string, detail?: unknown) => void write("debug", format(message, detail)),
};

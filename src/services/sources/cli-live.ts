/**
 * `ObsidianCli` over the `obsidian_cli` Tauri command (design.md D41). Rust
 * checks the arguments against a read-only allowlist, finds the binary (or uses
 * `obsidian.cliPath` from Settings) and runs it without a shell.
 */
import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer } from "effect";
import { Settings, settingsOrDefault } from "@/services/settings";
import { type CliOutput, ObsidianCli, SourceError } from ".";

const NOT_INSTALLED =
  "Turn on the command line interface in Obsidian: Settings > General > Advanced, then try again. If Obsidian is installed somewhere else, set the path in Settings > Data sources.";
const TIMEOUT = "Obsidian did not answer in time. Open Obsidian and try again.";

/** Maps a rejected `obsidian_cli` call; Rust prefixes the kinds it knows. */
export function invokeError(cause: unknown): SourceError {
  const text = cause instanceof Error ? cause.message : String(cause);
  const message = text.startsWith("not_installed")
    ? NOT_INSTALLED
    : text.startsWith("timeout")
      ? TIMEOUT
      : text || "The Obsidian command failed.";
  return new SourceError({ kind: "unavailable", message });
}

export const ObsidianCliLive = Layer.effect(
  ObsidianCli,
  Effect.gen(function* () {
    const settings = yield* Settings;
    return {
      run: (args) =>
        Effect.gen(function* () {
          const { obsidian } = yield* settingsOrDefault(settings);
          const cliPath = obsidian.cliPath.trim() || null;
          return yield* Effect.tryPromise({
            try: () => invoke<CliOutput>("obsidian_cli", { args: [...args], cliPath }),
            catch: invokeError,
          });
        }),
    };
  }),
);

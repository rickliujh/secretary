/**
 * `NoteFile` over the `daily_note_read` and `daily_note_write` Tauri commands
 * (D65). Rust finds the vault's daily note through the read-only Obsidian CLI,
 * checks it is a `.md` file inside the vault, and writes it only when it still
 * holds the expected text. Without `launch`, a closed Obsidian is not started:
 * Rust answers "not_running:". Images in the note (D70) go through
 * `note_image_save` and `note_image_load`, the bytes as base64.
 */
import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer } from "effect";
import { bytesToBase64 } from "@/lib/base64";
import { Settings, settingsOrDefault } from "@/services/settings";
import { invokeError } from "@/services/sources/cli-live";
import {
  NoteError,
  NoteFile,
  type NoteFileRead,
  type NoteFileWrite,
  type NoteImageLoaded,
  type NoteImageSaved,
} from ".";

const noteError = (cause: unknown) => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.startsWith("not_running")
    ? new NoteError({ kind: "not_running", message: "Obsidian is not running." })
    : new NoteError({ kind: "unavailable", message: invokeError(cause).message });
};

export const NoteFileLive = Layer.effect(
  NoteFile,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const cliPath = Effect.map(
      Effect.orElseSucceed(settingsOrDefault(settings), () => null),
      (s) => s?.obsidian.cliPath.trim() || null,
    );
    return {
      read: (vault, launch) =>
        Effect.flatMap(cliPath, (cli) =>
          Effect.tryPromise({
            try: () => invoke<NoteFileRead>("daily_note_read", { vault, cliPath: cli, launch }),
            catch: noteError,
          }),
        ),
      write: (vault, text, expected, launch) =>
        Effect.flatMap(cliPath, (cli) =>
          Effect.tryPromise({
            try: () =>
              invoke<NoteFileWrite>("daily_note_write", {
                vault,
                cliPath: cli,
                text,
                expected,
                launch,
              }),
            catch: noteError,
          }),
        ),
      // D70: the image file is the only other write; Rust checks it lands
      // inside the vault (or the app's data folder) and never overwrites.
      saveImage: (vault, data, ext) =>
        Effect.flatMap(cliPath, (cli) =>
          Effect.tryPromise({
            try: () =>
              invoke<NoteImageSaved>("note_image_save", {
                vault,
                cliPath: cli,
                launch: true,
                data: bytesToBase64(data),
                ext,
              }),
            catch: noteError,
          }),
        ),
      loadImage: (vault, link) =>
        Effect.flatMap(cliPath, (cli) =>
          Effect.tryPromise({
            try: () =>
              invoke<NoteImageLoaded | null>("note_image_load", { vault, cliPath: cli, link }),
            catch: noteError,
          }),
        ),
    };
  }),
);

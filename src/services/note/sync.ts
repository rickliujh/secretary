/**
 * The daily note in sync with Obsidian (FR-20.2, D65). When Settings >
 * Secretary > Daily note names an enabled Obsidian source, the vault's own
 * daily note is the file of record: today's page and the file are merged
 * against `base`, the text both last agreed on, and the result is written to
 * the file (compare-and-swap; on a conflict the file is read again and the
 * merge retried once) and kept as the page's text and the new base. Without a
 * base for this vault (the first sync, or another vault) the base is empty, so
 * both sides are kept, the file's first.
 */
import { Effect } from "effect";
import { Settings, settingsOrDefault } from "@/services/settings";
import { NoteError, NoteFile, type NoteFileRead, type SyncStatus } from ".";
import { mergeNote } from "./merge";
import { loadRow, saveSynced } from "./queries";

/** The data source the note syncs with: named in Settings and enabled; else null. */
export const noteVault = Effect.gen(function* () {
  const settings = yield* settingsOrDefault(yield* Settings);
  const id = settings.secretary.dailyNote.vaultSourceId;
  if (!id) return null;
  return settings.dataSources.find((d) => d.id === id && d.enabled) ?? null;
});

/** Merges today's page with the vault's daily note; "off" without a chosen vault. */
export const syncNote = (date: string, launch = false) =>
  Effect.gen(function* () {
    const source = yield* noteVault;
    if (!source) return { state: "off" } satisfies SyncStatus;
    const file = yield* NoteFile;
    const attempt = Effect.gen(function* () {
      const row = yield* loadRow(date);
      const page = row?.body ?? "";
      const base = row && row.vaultSourceId === source.id ? (row.base ?? "") : "";
      let current: NoteFileRead = yield* file.read(source.vault, launch);
      for (let tries = 0; ; tries++) {
        const merged = mergeNote(base, page, current.text ?? "");
        const same = current.text === null ? merged.text === "" : merged.text === current.text;
        if (!same) {
          const w = yield* file.write(source.vault, merged.text, current.text, launch);
          if (w.conflict) {
            if (tries >= 1)
              return yield* new NoteError({
                kind: "unavailable",
                message: "The daily note kept changing in Obsidian while it was saved. Try again.",
              });
            current = { path: w.path, text: w.text };
            continue;
          }
        }
        const at = yield* saveSynced(date, merged.text, source.id);
        return {
          state: "synced",
          vault: source.name,
          path: current.path,
          at,
          conflict: merged.conflict,
          changed: merged.text !== page,
        } satisfies SyncStatus;
      }
    });
    return yield* attempt.pipe(
      Effect.catchTag("NoteError", (e) =>
        Effect.succeed(
          (e.kind === "not_running"
            ? { state: "not_running", vault: source.name }
            : { state: "error", vault: source.name, message: e.message }) as SyncStatus,
        ),
      ),
    );
  });

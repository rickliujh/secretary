/**
 * A fake vault daily note for tests (D65): one file per vault, read and
 * written with the same compare-and-swap as the Rust command. Tests change
 * `files` directly to stand for edits made in Obsidian.
 */
import { Effect, Layer } from "effect";
import { NoteError, NoteFile } from ".";
import { DailyNoteLive } from "./live";

/** `DailyNote` over a fake vault file; it still needs Db, Settings, Intake and Llm. */
export const dailyNoteTestLayer = (initial: Record<string, string | null> = {}) =>
  DailyNoteLive.pipe(Layer.provide(makeNoteFileTest(initial).layer));

export function makeNoteFileTest(initial: Record<string, string | null> = {}) {
  const files = new Map<string, string | null>(Object.entries(initial));
  const writes: { vault: string; text: string; expected: string | null }[] = [];
  /** Each call's `launch`, in order. */
  const launches: boolean[] = [];
  const state: {
    /** Every call fails, as an Obsidian that does not answer. */
    down: boolean;
    /** Obsidian is open; a call without `launch` fails with not_running otherwise. */
    running: boolean;
    path: string;
    beforeWrite?: () => void;
  } = { down: false, running: true, path: "Daily/today.md" };
  const check = (vault: string, launch: boolean) => {
    launches.push(launch);
    if (!state.running && !launch)
      return Effect.fail(
        new NoteError({ kind: "not_running", message: "Obsidian is not running." }),
      );
    if (state.down)
      return Effect.fail(
        new NoteError({ kind: "unavailable", message: "Obsidian did not answer." }),
      );
    state.running = true;
    return files.has(vault)
      ? Effect.void
      : Effect.fail(new NoteError({ kind: "unavailable", message: `No vault ${vault}.` }));
  };
  const layer = Layer.succeed(NoteFile, {
    read: (vault, launch) =>
      Effect.map(check(vault, launch), () => ({
        path: state.path,
        text: files.get(vault) ?? null,
      })),
    write: (vault, text, expected, launch) =>
      Effect.map(check(vault, launch), () => {
        // Obsidian writing between the app's read and its write.
        const before = state.beforeWrite;
        state.beforeWrite = undefined;
        before?.();
        const current = files.get(vault) ?? null;
        if (current !== expected) return { path: state.path, conflict: true, text: current };
        files.set(vault, text);
        writes.push({ vault, text, expected });
        return { path: state.path, conflict: false, text: null };
      }),
  });
  return { layer, files, writes, state, launches };
}

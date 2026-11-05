/**
 * A fake vault daily note for tests (D65): one file per vault, read and
 * written with the same compare-and-swap as the Rust command. Tests change
 * `files` directly to stand for edits made in Obsidian. Images (D70) live in
 * `images`, keyed by `imageKey(vault, name)`.
 */
import { Effect, Layer } from "effect";
import { bytesToBase64 } from "@/lib/base64";
import { NoteError, NoteFile, type NoteImageLoaded } from ".";
import { DailyNoteLive } from "./live";

/** `DailyNote` over a fake vault file; it still needs Db, Settings, Intake and Llm. */
export const dailyNoteTestLayer = (initial: Record<string, string | null> = {}) =>
  DailyNoteLive.pipe(Layer.provide(makeNoteFileTest(initial).layer));

/** Where the fake keeps an image: the vault's name ("" without one) and the file name. */
export const imageKey = (vault: string | null, name: string) => `${vault ?? ""}/${name}`;

export function makeNoteFileTest(initial: Record<string, string | null> = {}) {
  const files = new Map<string, string | null>(Object.entries(initial));
  const images = new Map<string, NoteImageLoaded>();
  let imageCount = 0;
  const writes: { vault: string; text: string; expected: string | null }[] = [];
  /** Each call's `launch`, in order. */
  const launches: boolean[] = [];
  /** Each `loadImage` call's link, in order (D71: a private block loads none). */
  const loads: string[] = [];
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
    // Images (D70): kept in memory per vault ("" without one), linked as
    // Obsidian's default `![[name]]`.
    saveImage: (vault, data, ext) => {
      const saved = () => {
        const name = `Pasted image ${++imageCount}.${ext === "jpeg" ? "jpg" : ext}`;
        images.set(imageKey(vault, name), {
          mime: ext === "png" ? "image/png" : `image/${ext}`,
          data: bytesToBase64(data),
        });
        return { path: `${vault ?? "app"}/${name}`, link: `![[${name}]]` };
      };
      return vault === null ? Effect.sync(saved) : Effect.map(check(vault, true), saved);
    },
    loadImage: (vault, link) => {
      loads.push(link);
      const found = () => images.get(imageKey(vault, link)) ?? null;
      return vault === null ? Effect.sync(found) : Effect.map(check(vault, false), found);
    },
  });
  return { layer, files, writes, state, launches, images, loads };
}

/**
 * `DailyNote` (D65): the page's load and save, the sync with the vault and the
 * reading. Saves and syncs take turns, so a keystroke never lands between a
 * sync's read and its write; readings take turns too, so one block is never
 * sent by two at once.
 */
import { Effect, Layer } from "effect";
import { localDate } from "@/lib/dates";
import { bindDb, Db } from "@/services/db";
import type { Intake } from "@/services/intake";
import type { Llm } from "@/services/llm";
import type { Settings } from "@/services/settings";
import { DailyNote, type DayNote, NoteError, type NoteFile, type ReadTrigger } from ".";
import { mergeNote } from "./merge";
import { loadLastRead, loadRow, saveBody } from "./queries";
import { readNote } from "./read";
import { syncNote } from "./sync";

const make = Effect.gen(function* () {
  const { withDb } = bindDb(yield* Db);
  const context = yield* Effect.context<Settings | NoteFile | Intake | Llm>();
  const deps = <A, E>(e: Effect.Effect<A, E, Settings | NoteFile | Intake | Llm>) =>
    Effect.provide(e, context);
  const writing = yield* Effect.makeSemaphore(1);
  const reading = yield* Effect.makeSemaphore(1);

  const load = (date: string) =>
    Effect.map(
      withDb(loadRow(date)),
      (row): DayNote => ({
        date,
        body: row?.body ?? "",
        updatedAt: row?.updatedAt ?? null,
        editable: date === localDate(),
        syncedAt: row?.syncedAt ?? null,
      }),
    );

  const saveUnlocked = (date: string, body: string) =>
    Effect.gen(function* () {
      if (date !== localDate())
        return yield* new NoteError({
          kind: "read_only",
          message: "Only today's note can be edited.",
        });
      yield* withDb(saveBody(date, body));
      return yield* load(date);
    });

  /**
   * Compare-and-swap on the stored body: when it is no longer the text the
   * page last loaded (`expected`), a sync or the chat changed it since, so the
   * page's edits are merged onto it instead of writing over it.
   */
  const save = (date: string, body: string, expected?: string) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        if (expected === undefined) return yield* saveUnlocked(date, body);
        const stored = (yield* withDb(loadRow(date)))?.body ?? "";
        const next = stored === expected ? body : mergeNote(expected, body, stored).text;
        return yield* saveUnlocked(date, next);
      }),
    );

  const append = (line: string) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const date = localDate();
        const text = line.trim();
        const { body } = yield* load(date);
        if (!text) return yield* load(date);
        const sep = body === "" ? "" : body.endsWith("\n") ? "" : "\n";
        return yield* saveUnlocked(date, `${body}${sep}${text}\n`);
      }),
    );

  const sync = (opts: { launch?: boolean } = {}) =>
    writing.withPermits(1)(deps(withDb(syncNote(localDate(), opts.launch ?? false))));

  const read = (trigger: ReadTrigger) =>
    reading.withPermits(1)(
      Effect.gen(function* () {
        // The file of record first, so lines written in Obsidian are read too.
        yield* sync({ launch: trigger === "button" });
        return yield* deps(withDb(readNote(trigger)));
      }),
    );

  return DailyNote.of({ load, save, append, sync, read, lastRead: withDb(loadLastRead) });
});

export const DailyNoteLive = Layer.effect(DailyNote, make);

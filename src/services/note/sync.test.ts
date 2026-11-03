/**
 * The daily note in sync with a vault (FR-20.2, D65), over a fake vault file
 * with the Rust command's compare-and-swap.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { localDate } from "@/lib/dates";
import { defaultSettings } from "@/services/settings/schema";
import { intakeTestLayer } from "@/test/intake-layer";
import { DailyNote } from ".";

const VAULT = {
  id: "v1",
  kind: "obsidian" as const,
  name: "Work notes",
  vault: "Work",
  enabled: true,
};

function setup(file: string | null, vaultSourceId = "v1") {
  const s = defaultSettings();
  const t = intakeTestLayer({}, [], {
    dataSources: [VAULT],
    noteFiles: { Work: file },
    settings: {
      secretary: { ...s.secretary, dailyNote: { ...s.secretary.dailyNote, vaultSourceId } },
    },
  });
  const run = <A, E>(f: (n: typeof DailyNote.Service) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.provide(Effect.flatMap(DailyNote, f), t.layer) as Effect.Effect<A>);
  return { ...t, run };
}

describe("sync with the vault's daily note (D65)", () => {
  test("first connect: the page and the file are both kept, the file's first", async () => {
    const t = setup("from obsidian\n");
    const today = localDate();
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.save(today, "typed on the page\n");
        const status = yield* n.sync();
        return { status, day: yield* n.load(today) };
      }),
    );
    expect(r.status).toMatchObject({ state: "synced", vault: "Work notes", conflict: false });
    expect(r.day.body).toBe("from obsidian\n\ntyped on the page\n");
    expect(t.noteFile.files.get("Work")).toBe("from obsidian\n\ntyped on the page\n");
  });

  test("a line added in the file appears on the page; one typed on the page reaches the file", async () => {
    const t = setup("line one\n");
    const today = localDate();
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.sync();
        t.noteFile.files.set("Work", "line one\nwritten in obsidian\n");
        yield* n.sync();
        const afterFile = (yield* n.load(today)).body;
        yield* n.save(today, `${afterFile}typed on the page\n`);
        yield* n.sync();
        return { afterFile };
      }),
    );
    expect(r.afterFile).toBe("line one\nwritten in obsidian\n");
    expect(t.noteFile.files.get("Work")).toBe("line one\nwritten in obsidian\ntyped on the page\n");
  });

  test("edits on both sides since the last sync are both kept; same lines flag a conflict", async () => {
    const t = setup("a\nb\nc\n");
    const today = localDate();
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.sync();
        t.noteFile.files.set("Work", "a\nb\nc\nfile end\n");
        yield* n.save(today, "page start\na\nb\nc\n");
        const clean = yield* n.sync();
        const merged = (yield* n.load(today)).body;
        t.noteFile.files.set("Work", "page start\na\nB in obsidian\nc\nfile end\n");
        yield* n.save(today, "page start\na\nB on the page\nc\nfile end\n");
        const clash = yield* n.sync();
        return { clean, merged, clash, final: (yield* n.load(today)).body };
      }),
    );
    expect(r.clean).toMatchObject({ state: "synced", conflict: false });
    expect(r.merged).toBe("page start\na\nb\nc\nfile end\n");
    expect(r.clash).toMatchObject({ state: "synced", conflict: true });
    expect(r.final).toBe("page start\na\nB in obsidian\n\nB on the page\n\nc\nfile end\n");
    expect(t.noteFile.files.get("Work")).toBe(r.final);
  });

  test("a missing note is created; nothing is written when nothing changed", async () => {
    const t = setup(null);
    const today = localDate();
    await t.run((n) =>
      Effect.gen(function* () {
        yield* n.sync();
        yield* n.save(today, "first line\n");
        yield* n.sync();
        yield* n.sync();
      }),
    );
    expect(t.noteFile.writes).toEqual([{ vault: "Work", text: "first line\n", expected: null }]);
  });

  test("a save from a page loaded before a sync merges, so Obsidian's new line is not deleted", async () => {
    const t = setup("P\n");
    const today = localDate();
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.sync();
        const loaded = (yield* n.load(today)).body;
        // A reading syncs while the page is open: Obsidian's line X lands in the note.
        t.noteFile.files.set("Work", "P\nX\n");
        yield* n.sync();
        // The page still holds what it loaded and the user types k.
        const saved = yield* n.save(today, `${loaded}k\n`, loaded);
        yield* n.sync();
        return { loaded, saved: saved.body };
      }),
    );
    expect(r.loaded).toBe("P\n");
    expect(r.saved).toContain("X\n");
    expect(r.saved).toContain("k\n");
    expect(t.noteFile.files.get("Work")).toBe(r.saved);
  });

  test("without a vault, a save after the chat appended keeps the chat's line", async () => {
    const t = setup(null, "");
    const today = localDate();
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.save(today, "first\n");
        yield* n.append("from the chat");
        return (yield* n.save(today, "first\nfrom the page\n", "first\n")).body;
      }),
    );
    expect(r).toContain("from the chat");
    expect(r).toContain("from the page");
  });

  test("polls and passes never start Obsidian; opening the page and Read now may", async () => {
    const t = setup("x\n");
    t.noteFile.state.running = false;
    const r = await t.run((n) =>
      Effect.gen(function* () {
        const poll = yield* n.sync();
        const pass = yield* Effect.either(n.read("pass"));
        const before = t.noteFile.state.running;
        const opened = yield* n.sync({ launch: true });
        return { poll, pass, before, opened };
      }),
    );
    expect(r.poll).toEqual({ state: "not_running", vault: "Work notes" });
    expect(r.before).toBe(false);
    expect(r.opened).toMatchObject({ state: "synced" });
    expect(t.noteFile.launches.slice(0, 2)).toEqual([false, false]);
    expect(t.noteFile.launches.at(-1)).toBe(true);
  });

  test("a write that finds the file changed reads it again and merges once more", async () => {
    const t = setup("one\n");
    const today = localDate();
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.sync();
        yield* n.save(today, "one\npage\n");
        t.noteFile.state.beforeWrite = () => t.noteFile.files.set("Work", "zero\none\n");
        const status = yield* n.sync();
        return { status, body: (yield* n.load(today)).body };
      }),
    );
    expect(r.status).toMatchObject({ state: "synced" });
    expect(r.body).toBe("zero\none\npage\n");
    expect(t.noteFile.files.get("Work")).toBe("zero\none\npage\n");
  });

  test('the first enabled vault by default, none with "none"; an unreachable vault is an error status', async () => {
    const auto = setup("x\n", "");
    expect(await auto.run((n) => n.sync())).toMatchObject({ state: "synced", vault: "Work notes" });
    const off = setup("x\n", "none");
    expect(await off.run((n) => n.sync())).toEqual({ state: "off" });
    const down = setup("x\n");
    down.noteFile.state.down = true;
    expect(await down.run((n) => n.sync())).toMatchObject({
      state: "error",
      vault: "Work notes",
      message: "Obsidian did not answer.",
    });
  });

  test("the chat's append goes through the page's text and reaches the file at the next sync", async () => {
    const t = setup("from obsidian\n");
    const r = await t.run((n) =>
      Effect.gen(function* () {
        yield* n.sync();
        yield* n.append("call the bank");
        yield* n.sync();
        return (yield* n.load(localDate())).body;
      }),
    );
    expect(r).toBe("from obsidian\ncall the bank\n");
    expect(t.noteFile.files.get("Work")).toBe(r);
  });
});

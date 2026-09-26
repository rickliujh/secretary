import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { sourceDocuments } from "@/db/schema";
import { type Db, query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { type DataSource, Settings } from "@/services/settings";
import { DataSourceSchema } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { Sources } from ".";
import { SourcesLive } from "./live";
import { FIXTURE_VAULT_DIR, loadVaultFromDisk, type MemoryVaults, makeVaultFsTest } from "./test";

const WORK = "/vaults/work";
const HOME = "/vaults/home";
const fixture = () => loadVaultFromDisk(FIXTURE_VAULT_DIR);

const source = (patch: Partial<DataSource> = {}): DataSource =>
  DataSourceSchema.parse({
    id: "work",
    kind: "obsidian",
    name: "Work vault",
    path: WORK,
    exclude: ["Private"],
    ...patch,
  });
const home = (patch: Partial<DataSource> = {}) =>
  source({ id: "home", name: "Home", path: HOME, exclude: [], ...patch });

const homeVault = {
  "Garden.md": { text: "# Garden\n\nPlant the ledger tulips in spring.", mtime: 1 },
};

function setup(dataSources: DataSource[], vaults: MemoryVaults) {
  const fs = makeVaultFsTest(vaults);
  const layer = SourcesLive.pipe(
    Layer.provideMerge(Layer.mergeAll(DbTest, makeSettingsTest({ dataSources }), fs.layer)),
  );
  const run = <A, E>(e: Effect.Effect<A, E, Sources | Settings | Db>) =>
    Effect.runPromise(Effect.provide(e, layer));
  return { fs, run };
}

const setSources = (f: (s: DataSource[]) => DataSource[]) =>
  Effect.flatMap(Settings, (s) => s.update((cur) => ({ ...cur, dataSources: f(cur.dataSources) })));

const paths = (sourceId: string) =>
  query((d) =>
    d
      .select({ path: sourceDocuments.path })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.sourceId, sourceId))
      .all(),
  ).pipe(Effect.map((rows) => rows.map((r) => r.path).sort()));

describe("Sources.index", () => {
  test("first run indexes every eligible note, skipping dot and excluded folders", async () => {
    const { run } = setup([source()], { [WORK]: fixture() });
    const r = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        const results = yield* sources.index();
        return { results, stored: yield* paths("work"), status: yield* sources.status };
      }),
    );
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      sourceId: "work",
      added: 6,
      updated: 0,
      removed: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(r.stored).toEqual([
      "Daily/2026-09-25.md",
      "Inbox/Scratch.md",
      "Meetings/2026-09-14 Ledger sync.md",
      "Meetings/2026-09-21 Planning.md",
      "People/Dana Kim.md",
      "Projects/Ledger export.md",
    ]);
    expect(r.status).toEqual([
      { sourceId: "work", documents: 6, lastIndexedAt: expect.any(String), lastError: null },
    ]);
  });

  test("incremental: reads only new and changed files, removes deleted ones", async () => {
    const { run, fs } = setup([source()], { [WORK]: fixture() });
    const r = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        yield* sources.index();
        fs.reads.length = 0;
        const daily = fs.vaults[WORK]["Daily/2026-09-25.md"];
        fs.write(WORK, "Daily/2026-09-25.md", { text: `${daily.text}\nMore #later`, mtime: 2e12 });
        fs.remove(WORK, "People/Dana Kim.md");
        fs.write(WORK, "Projects/Archive cleanup.md", { text: "# Archive cleanup", mtime: 2e12 });
        const second = yield* sources.index();
        const secondReads = [...fs.reads].sort();
        fs.reads.length = 0;
        const third = yield* sources.index();
        const thirdReads = [...fs.reads];
        const forced = yield* sources.index({ force: true });
        const daily2 = yield* sources.read("work", "Daily/2026-09-25.md");
        return {
          second,
          secondReads,
          third,
          thirdReads,
          forced,
          stored: yield* paths("work"),
          daily2,
        };
      }),
    );
    expect(r.second[0]).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 4 });
    expect(r.secondReads).toEqual([
      `${WORK}:Daily/2026-09-25.md`,
      `${WORK}:Projects/Archive cleanup.md`,
    ]);
    expect(r.third[0]).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 6 });
    expect(r.thirdReads).toEqual([]);
    expect(r.forced[0]).toMatchObject({ updated: 6, unchanged: 0 });
    expect(r.stored).not.toContain("People/Dana Kim.md");
    expect(r.daily2.tags).toContain("later");
  });

  test("newly excluded folders and oversized files leave the index", async () => {
    const { run, fs } = setup([source()], { [WORK]: fixture() });
    const r = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        yield* sources.index();
        yield* setSources(([s]) => [{ ...s, exclude: ["Private", "meetings/"] }]);
        fs.write(WORK, "Daily/2026-09-25.md", { text: "big", mtime: 3e12, size: 3 * 1024 * 1024 });
        const again = yield* sources.index();
        return { again, stored: yield* paths("work") };
      }),
    );
    expect(r.again[0]).toMatchObject({ removed: 3, skipped: 1, unchanged: 3 });
    expect(r.stored).toEqual([
      "Inbox/Scratch.md",
      "People/Dana Kim.md",
      "Projects/Ledger export.md",
    ]);
  });

  test("removed sources lose their rows; disabled ones keep them but are not searched", async () => {
    const { run } = setup([source(), home()], { [WORK]: fixture(), [HOME]: homeVault });
    const r = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        yield* sources.index();
        const both = yield* sources.search("ledger", { limit: 20 });
        yield* setSources((all) =>
          all.map((s) => (s.id === "home" ? { ...s, enabled: false } : s)),
        );
        const disabled = yield* sources.search("ledger", { limit: 20 });
        const onlyHome = yield* sources.search("tulips", { sourceId: "home" });
        const homeRowsWhileDisabled = yield* paths("home");
        const readDisabled = yield* Effect.flip(sources.read("home", "Garden"));
        yield* setSources((all) => all.filter((s) => s.id !== "home"));
        const results = yield* sources.index();
        return {
          both,
          disabled,
          onlyHome,
          homeRowsWhileDisabled,
          readDisabled,
          results,
          homeRows: yield* paths("home"),
          status: yield* sources.status,
        };
      }),
    );
    expect(r.both.map((h) => h.sourceId)).toContain("home");
    expect(r.disabled.length).toBeGreaterThan(0);
    expect(r.disabled.every((h) => h.sourceId === "work")).toBe(true);
    expect(r.onlyHome).toEqual([]);
    expect(r.homeRowsWhileDisabled).toEqual(["Garden.md"]);
    expect(r.readDisabled).toMatchObject({ _tag: "SourceError", kind: "not_found" });
    expect(r.results.map((x) => x.sourceId)).toEqual(["work"]);
    expect(r.homeRows).toEqual([]);
    expect(r.status.map((s) => s.sourceId)).toEqual(["work"]);
  });

  test("an unreadable folder is recorded; it raises only when indexed by id", async () => {
    const { run, fs } = setup([source(), home()], { [WORK]: fixture(), [HOME]: homeVault });
    const r = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        yield* sources.index();
        fs.removeRoot(HOME);
        const all = yield* sources.index();
        const one = yield* Effect.flip(sources.index({ sourceId: "home" }));
        const unknown = yield* Effect.flip(sources.index({ sourceId: "nope" }));
        return { all, one, unknown, status: yield* sources.status };
      }),
    );
    expect(r.all.map((x) => x.sourceId)).toEqual(["work"]);
    expect(r.one).toMatchObject({ _tag: "SourceError", kind: "no_access" });
    expect(r.unknown).toMatchObject({ _tag: "SourceError", kind: "not_found" });
    const homeStatus = r.status.find((s) => s.sourceId === "home");
    expect(homeStatus?.lastError).toContain("Settings > Data sources");
    // Earlier rows and the last good run stay.
    expect(homeStatus?.documents).toBe(1);
    expect(homeStatus?.lastIndexedAt).not.toBeNull();
    expect(r.status.find((s) => s.sourceId === "work")?.lastError).toBeNull();
  });

  test("indexIfStale runs only when the last run is older than the limit, and never fails", async () => {
    const { run, fs } = setup([source(), home()], { [WORK]: fixture(), [HOME]: homeVault });
    const r = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        yield* sources.indexIfStale(60_000);
        const first = fs.reads.length;
        fs.write(WORK, "New.md", { text: "# New", mtime: 5e12 });
        yield* sources.indexIfStale(60_000);
        const fresh = fs.reads.length;
        fs.removeRoot(HOME);
        yield* sources.indexIfStale(0);
        return { first, fresh, after: fs.reads.length, stored: yield* paths("work") };
      }),
    );
    expect(r.first).toBe(7);
    expect(r.fresh).toBe(7);
    expect(r.after).toBe(8);
    expect(r.stored).toContain("New.md");
  });
});

describe("Sources.search", () => {
  const indexed = () => {
    const { run } = setup([source()], { [WORK]: fixture() });
    return <A, E>(f: (s: typeof Sources.Service) => Effect.Effect<A, E>) =>
      run(
        Effect.gen(function* () {
          const sources = yield* Sources;
          yield* sources.index();
          return yield* f(sources);
        }),
      );
  };

  test("title hits rank above body hits; hits carry source name, tags and time", async () => {
    const hits = await indexed()((s) => s.search("ledger export"));
    expect(hits[0]).toMatchObject({
      sourceId: "work",
      sourceName: "Work vault",
      path: "Projects/Ledger export.md",
      title: "Ledger export",
      tags: ["project", "finance/ledger", "q3"],
      modified: new Date(1_700_000_000_000).toISOString(),
    });
    expect(hits.map((h) => h.path)).toContain("Meetings/2026-09-14 Ledger sync.md");
  });

  test("aliases and tags are searchable; words missing from every note fall back to any word", async () => {
    const r = await indexed()((s) =>
      Effect.all({
        alias: s.search("LEDG"),
        tag: s.search("#followup"),
        anyWord: s.search("auditor zebra"),
        prefix: s.search("reten"),
      }),
    );
    expect(r.alias[0].path).toBe("Projects/Ledger export.md");
    expect(r.tag.map((h) => h.path)).toEqual(["Meetings/2026-09-14 Ledger sync.md"]);
    expect(r.anyWord.map((h) => h.path).sort()).toEqual([
      "Meetings/2026-09-14 Ledger sync.md",
      "Projects/Ledger export.md",
    ]);
    expect(r.prefix.map((h) => h.path)).toContain("Projects/Ledger export.md");
  });

  test("snippets come from the body around the match", async () => {
    const hits = await indexed()((s) => s.search("certificate"));
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("staging certificate");
    expect(hits[0].snippet).not.toContain("\n");
    const long = await indexed()((s) => s.search("auditor reversal", { limit: 1 }));
    expect(long[0].snippet).toContain("auditor");
    expect(long[0].snippet).toContain("…");
  });

  test("limit, excluded notes and unsearchable queries", async () => {
    const r = await indexed()((s) =>
      Effect.all({
        limited: s.search("ledger", { limit: 2 }),
        private: s.search("salary confidential"),
        dot: s.search("snippets"),
        empty: s.search("   "),
        punctuation: s.search('"*() OR'),
      }),
    );
    expect(r.limited).toHaveLength(2);
    expect(r.private).toEqual([]);
    expect(r.dot).toEqual([]);
    expect(r.empty).toEqual([]);
    expect(r.punctuation).toEqual([]);
  });
});

describe("Sources.read", () => {
  test("by exact path, path without .md, title or alias, with links and backlinks", async () => {
    const { run } = setup([source()], { [WORK]: fixture() });
    const r = await run(
      Effect.gen(function* () {
        const s = yield* Sources;
        yield* s.index();
        return {
          exact: yield* s.read("work", "Projects/Ledger export.md"),
          noExt: yield* s.read("work", "projects/ledger export"),
          title: yield* s.read("work", "Ledger export"),
          alias: yield* s.read("work", "LEDG export"),
          person: yield* s.read("work", "Dana Kim"),
          missing: yield* Effect.flip(s.read("work", "Nope")),
          unknown: yield* Effect.flip(s.read("nope", "Ledger export")),
        };
      }),
    );
    for (const doc of [r.exact, r.noExt, r.title, r.alias]) {
      expect(doc.path).toBe("Projects/Ledger export.md");
    }
    expect(r.exact).toMatchObject({
      sourceName: "Work vault",
      title: "Ledger export",
      aliases: ["Ledger CSV", "LEDG export"],
      tags: ["project", "finance/ledger", "q3"],
      links: ["Dana Kim", "People/Dana Kim"],
      frontmatter: expect.objectContaining({ status: "active", jira: "LEDG-142" }),
    });
    expect(r.exact.body.startsWith("# Ledger export")).toBe(true);
    expect(r.exact.body).toContain("make ledger-export");
    expect(r.exact.backlinks.sort()).toEqual([
      "2026-09-14 Ledger sync",
      "2026-09-21 Planning",
      "2026-09-25",
      "Dana Kim",
    ]);
    expect(r.person.backlinks.sort()).toEqual(["2026-09-14 Ledger sync", "Ledger export"]);
    expect(r.missing).toMatchObject({ _tag: "SourceError", kind: "not_found" });
    expect(r.unknown).toMatchObject({ _tag: "SourceError", kind: "not_found" });
  });
});

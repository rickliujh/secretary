import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeSettingsTest } from "@/services/settings/test";
import { SourceError, Sources } from ".";
import { cliError, parseFilePath, parseSearch, parseTable, splitFrontmatter } from "./cli-output";
import { SourcesLive } from "./live";
import { queryWords, rankResults, searchQueries } from "./rank";
import { FIXTURE_VAULT_DIR, loadVaultFromDisk, makeObsidianCliTest } from "./test";

const work = { id: "v1", kind: "obsidian" as const, name: "Work", vault: "Work", enabled: true };

const setup = (opts: Parameters<typeof makeObsidianCliTest>[1] = {}, sources = [work]) => {
  const cli = makeObsidianCliTest({ Work: loadVaultFromDisk(FIXTURE_VAULT_DIR) }, opts);
  const layer = SourcesLive.pipe(
    Layer.provide(Layer.merge(cli.layer, makeSettingsTest({ dataSources: sources }))),
  );
  const run = <A, E>(f: (s: Sources["Type"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.provide(Effect.flatMap(Sources, f), layer));
  return { cli, run };
};

describe("CLI output", () => {
  test("errors and empty results are text; results are JSON", () => {
    expect(cliError('Error: File "x" not found.', 0)).toMatchObject({ kind: "not_found" });
    expect(cliError("Vault not found.", 0)).toMatchObject({ kind: "not_found" });
    expect(
      cliError(
        "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.",
        0,
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(cliError("No matches found.", 0)).toBeNull();
    expect(cliError("boom", 1)).toMatchObject({ kind: "unavailable", message: "boom" });
    expect(parseSearch("No matches found.")).toEqual([]);
    expect(parseSearch('[{"file":"a.md","matches":[{"line":2,"text":"x"}]}]')).toEqual([
      { file: "a.md", matches: [{ line: 2, text: "x" }] },
    ]);
    expect(() => parseSearch("unexpected")).toThrow(SourceError);
    // Obsidian repeats a line for every query word it contains (seen on 1.13.7).
    expect(
      parseSearch(
        '[{"file":"a.md","matches":[{"line":3,"text":"x y"},{"line":3,"text":"x y"},{"line":6,"text":"y"}]}]',
      )[0]?.matches.map((m) => m.line),
    ).toEqual([3, 6]);
    expect(parseFilePath("path\tA/B c.md\nname\tB c\nextension\tmd")).toBe("A/B c.md");
    expect(parseTable('[{"file":"b.md"}]', "file")).toEqual(["b.md"]);
    expect(parseTable("No backlinks found.", "file")).toEqual([]);
    expect(splitFrontmatter("---\ntitle: X\n---\nBody")).toEqual({
      frontmatter: { title: "X" },
      body: "Body",
    });
  });

  test("queries: every word, then any; names with the words rank first", () => {
    const words = queryWords("How long do we keep ledger export files?");
    expect(words).toEqual(["long", "keep", "ledger", "export", "files"]);
    expect(queryWords("What did we decide about the ledger?")).toEqual(["decide", "ledger"]);
    expect(searchQueries(["ledger", "q3-plan"])).toEqual({
      all: 'ledger "q3-plan"',
      any: 'ledger OR "q3-plan"',
    });
    const ranked = rankResults(
      ["ledger", "export"],
      [
        [
          {
            file: "Meetings/Planning.md",
            matches: [1, 2, 3].map((line) => ({ line, text: "ledger export" })),
          },
          { file: "Projects/Ledger export.md", matches: [{ line: 1, text: "# Ledger export" }] },
        ],
        [{ file: "Ledger.md", matches: [{ line: 1, text: "ledger" }] }],
      ],
    );
    expect(ranked.map((r) => r.path)).toEqual([
      "Projects/Ledger export.md",
      "Ledger.md",
      "Meetings/Planning.md",
    ]);
  });
});

describe("Sources over the Obsidian CLI (D41)", () => {
  test("search ranks the project note first and respects Obsidian's excluded files", async () => {
    const { run, cli } = setup({ excluded: ["Private"] });
    const hits = await run((s) => s.search("ledger export retention"));
    expect(hits[0]).toMatchObject({
      title: "Ledger export",
      path: "Projects/Ledger export.md",
      sourceName: "Work",
    });
    expect(hits.every((h) => !h.path.startsWith("Private/"))).toBe(true);
    expect(hits[0]?.snippet).toContain("Retention");
    expect(cli.calls[0]).toEqual([
      "vault=Work",
      "search:context",
      "query=ledger export retention",
      "format=json",
    ]);
  });

  test("read resolves a name like a link and returns properties, tags and backlinks", async () => {
    const { run } = setup();
    const note = await run((s) => s.read("v1", "[[Ledger export#Decisions|the export]]"));
    expect(note.path).toBe("Projects/Ledger export.md");
    expect(note.properties).toMatchObject({ jira: "LEDG-142" });
    expect(note.body).toContain("Retention of generated files is 90 days");
    expect(note.tags).toContain("project");
    expect(note.backlinks.length).toBeGreaterThan(0);
  });

  test("errors: unknown note, CLI turned off, disabled vault", async () => {
    const missing = await setup().run((s) => Effect.flip(s.read("v1", "Nope")));
    expect(missing).toMatchObject({ kind: "not_found" });
    const off = await setup({ enabled: false }).run((s) => Effect.flip(s.search("ledger")));
    expect(off.message).toContain("Command line interface");
    const disabled = await setup({}, [{ ...work, enabled: false }]).run((s) => s.search("ledger"));
    expect(disabled).toEqual([]);
  });

  test("vaults and check", async () => {
    const { run } = setup();
    expect(await run((s) => s.vaults)).toEqual(["Work"]);
    expect(await run((s) => s.check("v1"))).toMatchObject({ ok: true });
    const wrong = await setup({}, [{ ...work, vault: "Gone" }]).run((s) => s.check("v1"));
    expect(wrong).toMatchObject({ ok: false, kind: "not_found" });
  });
});

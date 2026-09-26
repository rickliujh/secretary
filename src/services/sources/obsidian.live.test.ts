/**
 * The Sources service against a real, running Obsidian with its CLI turned on,
 * calling the `obsidian` binary directly instead of through Tauri. Opt in:
 *   SECRETARY_OBSIDIAN_VAULT=<vault name> [SECRETARY_OBSIDIAN_BIN=/path/to/obsidian] \
 *     bun test src/services/sources/obsidian.live.test.ts
 * The vault needs the notes from src/test/fixtures/vault under "Secretary test/".
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeSettingsTest } from "@/services/settings/test";
import { ObsidianCli, SourceError, Sources } from ".";
import { SourcesLive } from "./live";

const vault = process.env.SECRETARY_OBSIDIAN_VAULT;
const bin = process.env.SECRETARY_OBSIDIAN_BIN ?? "obsidian";

const RealCli = Layer.succeed(
  ObsidianCli,
  ObsidianCli.of({
    run: (args) =>
      Effect.tryPromise({
        try: async () => {
          const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
          const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
          return { stdout, code };
        },
        catch: (e) => new SourceError({ kind: "unavailable", message: String(e) }),
      }),
  }),
);

describe.skipIf(!vault)("real Obsidian CLI (D41)", () => {
  const source = {
    id: "real",
    kind: "obsidian" as const,
    name: "Notes",
    vault: vault ?? "",
    enabled: true,
  };
  const run = <A, E>(f: (s: Sources["Type"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Sources, f),
        SourcesLive.pipe(
          Layer.provide(Layer.merge(RealCli, makeSettingsTest({ dataSources: [source] }))),
        ),
      ),
    );

  test("vaults, check, search, read", async () => {
    expect(await run((s) => s.vaults)).toContain(vault ?? "");
    expect(await run((s) => s.check("real"))).toMatchObject({ ok: true });
    const hits = await run((s) => s.search("ledger export retention"));
    console.log(hits.map((h) => `${h.title} (${h.matches}): ${h.snippet}`).join("\n"));
    expect(hits[0]?.path).toBe("Secretary test/Projects/Ledger export.md");
    const note = await run((s) => s.read("real", "Ledger export"));
    expect(note.path).toBe("Secretary test/Projects/Ledger export.md");
    expect(note.properties).toMatchObject({ jira: "LEDG-142" });
    expect(note.tags).toEqual(expect.arrayContaining(["project", "finance/ledger"]));
    expect(note.backlinks.length).toBe(3);
    const missing = await run((s) => Effect.flip(s.read("real", "No such note here")));
    expect(missing.kind).toBe("not_found");
  }, 60_000);
});

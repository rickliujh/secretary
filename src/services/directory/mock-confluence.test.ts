/** End-to-end over real HTTP: ConfluenceClient search and import against scripts/mock-confluence.ts. */
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfluenceClient } from "@/services/confluence";
import { textToCql } from "@/services/confluence/cql";
import { ConfluenceClientLive } from "@/services/confluence/live";
import { DbTest } from "@/services/db/test";
import { makeFetcherTest } from "@/services/http";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { createHandler } from "../../../scripts/mock-confluence";
import { importConfluencePage, listNotes } from "./notes";
import { createTeam } from "./queries";

const server = Bun.serve({ port: 0, fetch: createHandler() });
afterAll(() => server.stop(true));

const layer = Layer.provideMerge(
  ConfluenceClientLive,
  Layer.mergeAll(
    makeSettingsTest({
      ...defaultSettings(),
      confluence: { baseUrl: `http://localhost:${server.port}` },
    }),
    makeSecretsTest({ [secretNames.confluencePat]: "mock-token-000" }),
    makeFetcherTest((i, init) => fetch(i, init)),
    DbTest,
  ),
);

describe("Confluence search and import against the mock", () => {
  test("search a page, import it, see Markdown attached to a team", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const confluence = yield* ConfluenceClient;
          const found = yield* confluence.search(textToCql("escalation runbook") ?? "");
          const teamId = yield* createTeam({ name: "Payments" });
          const page = found.results[0];
          if (!page) throw new Error("no result");
          yield* importConfluencePage(page.id, { type: "team", id: teamId });
          return { found, notes: yield* listNotes({ type: "team", id: teamId }) };
        }),
        layer,
      ),
    );
    expect(r.found.results.map((x) => x.title)).toEqual(["Payments escalation runbook"]);
    const note = r.notes[0];
    expect(note?.title).toBe("Payments escalation runbook");
    expect(note?.bodyMd).toContain("> **Warning**");
    expect(note?.bodyMd).toContain(
      '```bash\npagerctl page payments-oncall --reason "INC0012345 ledger export blocked"\n```',
    );
    expect(note?.bodyMd).toContain("1. Post in **#payments-help**");
    expect(note?.sourceUrl).toBe(
      `http://localhost:${server.port}/display/PAY/Payments+escalation+runbook`,
    );
  });
});

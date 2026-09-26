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
      confluence: { ...defaultSettings().confluence, baseUrl: `http://localhost:${server.port}` },
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

describe("Confluence Cloud against the mock", () => {
  test("search on v1, import through v2 pages with the space key, Basic auth under /wiki", async () => {
    const cloudServer = Bun.serve({ port: 0, fetch: createHandler(undefined, { cloud: true }) });
    try {
      const seen: string[] = [];
      const cloudLayer = Layer.provideMerge(
        ConfluenceClientLive,
        Layer.mergeAll(
          makeSettingsTest({
            ...defaultSettings(),
            // Cloud is normally detected from atlassian.net; the mock runs on localhost, so force it.
            confluence: {
              baseUrl: `http://localhost:${cloudServer.port}/wiki/spaces/PAY`,
              deployment: "cloud",
              email: "rick@example.com",
            },
          }),
          makeSecretsTest({ [secretNames.confluencePat]: "api-token-000" }),
          makeFetcherTest((i, init) => {
            seen.push(i instanceof Request ? i.url : String(i));
            return fetch(i, init);
          }),
          DbTest,
        ),
      );
      const r = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const confluence = yield* ConfluenceClient;
            const me = yield* confluence.testConnection();
            const found = yield* confluence.search(textToCql("escalation runbook") ?? "");
            const teamId = yield* createTeam({ name: "Payments" });
            yield* importConfluencePage(found.results[0]?.id ?? "", { type: "team", id: teamId });
            return { me, found, notes: yield* listNotes({ type: "team", id: teamId }) };
          }),
          cloudLayer,
        ),
      );
      expect(r.me.displayName).toBe("Me Myself");
      expect(r.found.results.map((x) => x.title)).toEqual(["Payments escalation runbook"]);
      expect(r.notes[0]).toMatchObject({
        title: "Payments escalation runbook",
        sourceVersion: 3,
        sourceId: "65602",
      });
      expect(r.notes[0]?.bodyMd).toContain("> **Warning**");
      expect(r.notes[0]?.sourceUrl).toBe(
        `http://localhost:${cloudServer.port}/wiki/spaces/PAY/pages/65602/Payments+escalation+runbook`,
      );
      expect(seen.some((u) => u.includes("/wiki/api/v2/pages/65602?body-format=storage"))).toBe(
        true,
      );
      expect(seen.every((u) => u.includes("/wiki/"))).toBe(true);
    } finally {
      cloudServer.stop(true);
    }
  });
});

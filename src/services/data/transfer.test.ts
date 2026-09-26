import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { jiraIssues, memories, syncState } from "@/db/schema";
import { createDraft } from "@/services/comms/queries";
import { query } from "@/services/db";
import { createDependency, logFollowup } from "@/services/dependencies/queries";
import { createPerson, createTeam } from "@/services/directory/queries";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { exportAll, importAll, parseExport, resetCache } from "./transfer";

const seed = Effect.gen(function* () {
  yield* syncOnce;
  const team = yield* createTeam({ name: "Platform", function: "Shared infrastructure" });
  const person = yield* createPerson({
    displayName: "Priya Shah",
    teamId: team,
    profile: { formality: "formal" },
  });
  const dep = yield* createDependency({
    issueKey: "PAY-2",
    kind: "person",
    label: "Review",
    ownerPersonId: person,
  });
  yield* logFollowup(dep, { channel: "teams", summary: "Pinged" }, "2026-09-24");
  yield* createDraft({
    kind: "email",
    intent: "chase",
    recipientPersonId: person,
    dependencyId: dep,
    notes: "Chase the review",
  });
  yield* query((d) =>
    d.insert(memories).values({
      id: "m1",
      kind: "rule",
      content: "Copy Priya on escalations",
      source: "user",
      confirmed: true,
      createdAt: "2026-09-01T00:00:00Z",
    }),
  );
});

describe("export and import (D27)", () => {
  test("round-trips the user's data into a fresh database, without secrets or the Jira cache", async () => {
    const text = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          return JSON.stringify(yield* exportAll);
        }),
        syncedJiraLayer().layer,
      ),
    );
    // The Jira PAT from the test keychain never appears; the cache is not exported.
    expect(text).not.toContain("test-pat-000000");
    expect(text).not.toContain('"jira_issues"');
    const file = JSON.parse(text);
    expect(file.tables.people).toHaveLength(1);
    expect(file.tables.followups).toHaveLength(1);
    expect(file.tables.communications[0].notesMd).toBe("Chase the review");

    // A fresh app: import, then export again and compare.
    const again = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const parsed = yield* parseExport(text);
          const counts = yield* importAll(parsed);
          return { counts, exported: yield* exportAll };
        }),
        syncedJiraLayer().layer,
      ),
    );
    expect(again.counts).toMatchObject({
      people: 1,
      teams: 1,
      dependencies: 1,
      followups: 1,
      memories: 1,
    });
    expect(again.exported.tables).toEqual(file.tables);
    expect(again.exported.settings.jira.baseUrl).toBe(file.settings.jira.baseUrl);
  });

  test("bad files are refused before anything is changed", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const notJson = yield* Effect.either(parseExport("not json"));
          const other = yield* Effect.either(parseExport(JSON.stringify({ app: "other" })));
          const good = yield* exportAll;
          const badRow = yield* Effect.either(
            parseExport(
              JSON.stringify({
                ...good,
                tables: { ...good.tables, teams: [{ id: "t", evil: 1 }] },
              }),
            ),
          );
          return { notJson, other, badRow };
        }),
        syncedJiraLayer().layer,
      ),
    );
    expect(r.notJson._tag === "Left" && r.notJson.left.message).toBe(
      "That file is not valid JSON.",
    );
    expect(r.other._tag === "Left" && r.other.left.message).toContain("not a Secretary export");
    expect(r.badRow._tag === "Left" && r.badRow.left.message).toContain(
      'teams row 1: unknown field "evil"',
    );
    expect(r.badRow._tag === "Left" && r.badRow.left.message).toContain(
      'teams row 1: missing "name"',
    );
  });

  test("resetting the cache drops Jira data and sync state but keeps the user's data", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          yield* resetCache;
          return {
            issues: yield* query((d) => d.select().from(jiraIssues).all()),
            state: yield* query((d) => d.select().from(syncState).all()),
            exported: yield* exportAll,
          };
        }),
        syncedJiraLayer().layer,
      ),
    );
    expect(r.issues).toHaveLength(0);
    expect(r.state).toHaveLength(0);
    expect(r.exported.tables.people).toHaveLength(1);
  });
});

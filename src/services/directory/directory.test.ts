import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { people } from "@/db/schema";
import { ConfluenceClientLive } from "@/services/confluence/live";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { makeFetcherTest } from "@/services/http";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import page from "@/test/fixtures/confluence/page-65601.json";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { json, stubFetch } from "@/test/stub-fetch";
import { addNote, deleteNote, importConfluencePage, listNotes, searchNoteIds } from "./notes";
import {
  contactsByUsername,
  createPerson,
  createTeam,
  deleteTeam,
  getPerson,
  getTeam,
  jiraUsersWithoutContact,
  listPeople,
  updatePerson,
} from "./queries";
import { exportDirectory, importDirectory } from "./transfer";

const run = <A, E>(e: Effect.Effect<A, E, import("@/services/db").Db>) =>
  Effect.runPromise(Effect.provide(e, DbTest));

describe("teams and people", () => {
  test("create, read with members, update profile, delete team unlinks members", async () => {
    const r = await run(
      Effect.gen(function* () {
        const teamId = yield* createTeam({
          name: "Platform",
          function: "Runs the shared infrastructure",
          confluenceUrls: [],
        });
        const ana = yield* createPerson({
          displayName: "Ana Bell",
          jiraUsername: "Ana.B",
          email: "ana@example.com",
          teamId,
          profile: { formality: "formal", detail: "brief", tone: "" },
        });
        const withMembers = yield* getTeam(teamId);
        yield* updatePerson(ana, {
          displayName: "Ana Bell",
          jiraUsername: "ana.b",
          teamId,
          profile: { formality: "casual", preferredChannel: "teams" },
        });
        const updated = yield* getPerson(ana);
        yield* deleteTeam(teamId);
        const after = yield* query((db) =>
          db.select().from(people).where(eq(people.id, ana)).get(),
        );
        return { withMembers, updated, after };
      }),
    );
    expect(r.withMembers?.members.map((m) => m.displayName)).toEqual(["Ana Bell"]);
    // Empty profile fields are not stored.
    expect(r.updated?.person.profile).toEqual({ formality: "casual", preferredChannel: "teams" });
    expect(r.updated?.team?.name).toBe("Platform");
    expect(r.after?.teamId).toBeNull();
  });

  test("validation rejects bad input", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(createPerson({ displayName: " ", email: "nope" }), DbTest),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("matching contacts to Jira users", () => {
  const all = [...page1.issues, ...page2.issues];
  const layer = () => {
    const stub = stubFetch([
      { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
      { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
      { match: (u) => u.pathname.endsWith("/comment"), respond: () => json(comments) },
      {
        match: (u) => u.pathname.endsWith("/search"),
        respond: (r) => {
          const b = r.body as { startAt: number; jql: string };
          const src = b.jql.startsWith("(parent in") ? [] : all;
          return json({
            startAt: b.startAt,
            maxResults: 100,
            total: src.length,
            issues: src.slice(b.startAt),
          });
        },
      },
    ]);
    return Layer.provideMerge(SyncLive, jiraTestLayer(stub.fetch, jiraSettings()));
  };

  test("usernames match case-insensitively; unmatched Jira users are suggested by frequency", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const before = yield* jiraUsersWithoutContact;
          const ana = yield* createPerson({ displayName: "Ana Bell", jiraUsername: "ANA.B" });
          const map = yield* contactsByUsername;
          const after = yield* jiraUsersWithoutContact;
          const detail = yield* getPerson(ana);
          return { before, map, after, detail };
        }),
        layer(),
      ),
    );
    expect(r.before.map((u) => u.username)).toEqual(["rliu", "ana.b", "tom.k"]);
    expect(r.before.find((u) => u.username === "rliu")?.email).toBe("rick@example.com");
    expect(r.map.get("ana.b")?.displayName).toBe("Ana Bell");
    expect(r.after.map((u) => u.username)).not.toContain("ana.b");
    expect(r.detail?.issues.map((i) => i.key)).toEqual(["PAY-2"]);
  });
});

describe("context notes", () => {
  const confluenceLayer = () => {
    const stub = stubFetch([
      { match: (u) => u.pathname.endsWith("/rest/api/content/65601"), respond: () => json(page) },
    ]);
    const s = defaultSettings();
    return Layer.provideMerge(
      ConfluenceClientLive,
      Layer.mergeAll(
        makeSettingsTest({
          ...s,
          confluence: { ...defaultSettings().confluence, baseUrl: "https://wiki.example.com" },
        }),
        makeSecretsTest({ [secretNames.confluencePat]: "conf-pat-000000" }),
        makeFetcherTest(stub.fetch),
        DbTest,
      ),
    );
  };

  test("importing a Confluence page attaches Markdown to a team; re-import replaces it", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const teamId = yield* createTeam({ name: "Payments" });
          const subject = { type: "team" as const, id: teamId };
          const first = yield* importConfluencePage("65601", subject);
          const second = yield* importConfluencePage("65601", subject);
          const notes = yield* listNotes(subject);
          const hits = yield* searchNoteIds('"ledger"*');
          return { first, second, notes, hits };
        }),
        confluenceLayer(),
      ),
    );
    expect(r.first.replaced).toBe(false);
    expect(r.second.replaced).toBe(true);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({
      title: "Payments platform team",
      sourceUrl: "https://wiki.example.com/display/PAY/Payments+platform+team",
      sourceVersion: 7,
    });
    expect(r.notes[0]?.bodyMd).toContain("## What we own\n\n- Invoicing\n- Ledger exports");
    expect(r.notes[0]?.bodyMd).toContain("> **Info**");
    expect(r.hits.map((h) => h.id)).toEqual([r.first.noteId]);
  });

  test("free notes can be added and deleted", async () => {
    const r = await run(
      Effect.gen(function* () {
        const subject = { type: "person" as const, id: "p1" };
        const id = yield* addNote(subject, {
          title: "Prefers mornings",
          bodyMd: "Book calls before 11:00.",
        });
        const before = yield* listNotes(subject);
        yield* deleteNote(id);
        return { before, after: yield* listNotes(subject) };
      }),
    );
    expect(r.before).toHaveLength(1);
    expect(r.after).toHaveLength(0);
  });
});

describe("directory export and import", () => {
  test("round trip into an empty database, idempotent on repeat, rejects bad files", async () => {
    const exported = await run(
      Effect.gen(function* () {
        const teamId = yield* createTeam({
          name: "Network",
          confluenceUrls: ["https://wiki.example.com/x"],
        });
        const personId = yield* createPerson({
          displayName: "Tom Kay",
          teamId,
          profile: { detail: "detailed" },
        });
        yield* addNote(
          { type: "person", id: personId },
          { title: "Note", bodyMd: "Likes context." },
        );
        yield* addNote(
          { type: "issue", id: "PAY-2" },
          { title: "Issue note", bodyMd: "Not exported." },
        );
        return yield* exportDirectory;
      }),
    );
    expect(exported.notes).toHaveLength(1);
    expect(Object.keys(exported).sort()).toEqual([
      "exportedAt",
      "format",
      "notes",
      "people",
      "teams",
      "version",
    ]);

    const r = await run(
      Effect.gen(function* () {
        const first = yield* importDirectory(JSON.parse(JSON.stringify(exported)));
        yield* importDirectory(exported);
        const bad = yield* Effect.either(importDirectory({ format: "something-else" }));
        return { first, people: yield* listPeople, bad };
      }),
    );
    expect(r.first).toEqual({ teams: 1, people: 1, notes: 1 });
    expect(r.people).toHaveLength(1);
    expect(r.people[0]?.profile).toEqual({ detail: "detailed" });
    expect(r.bad._tag).toBe("Left");
  });
});

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { MIGRATIONS_TABLE, migrate, parseMigrations } from "@/db/migrator";
import { issueMeta, jiraIssues, llmCalls, people, teams } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from ".";
import { DbTest, loadMigrationsFromDisk, makeTestDatabase } from "./test";

describe("migrator", () => {
  test("parses drizzle-kit output in journal order", () => {
    const migrations = parseMigrations(
      {
        entries: [
          { idx: 1, tag: "0001_b", when: 2 },
          { idx: 0, tag: "0000_a", when: 1 },
        ],
      },
      {
        "0000_a": "CREATE TABLE a (x int);\n--> statement-breakpoint\nCREATE INDEX ai ON a (x);",
        "0001_b": "CREATE TABLE b (y int);",
      },
    );
    expect(migrations.map((m) => m.tag)).toEqual(["0000_a", "0001_b"]);
    expect(migrations[0]?.statements).toHaveLength(2);
  });

  test("bundled migrations create every table and are idempotent", async () => {
    const { sqlite, select } = await makeTestDatabase();
    const tables = select("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
      (r) => r.name,
    );
    for (const name of [
      "jira_issues",
      "jira_comments",
      "issue_meta",
      "issue_notes",
      "teams",
      "people",
      "context_notes",
      "dependencies",
      "followups",
      "inbox_items",
      "proposals",
      "actions_log",
      "memories",
      "communications",
      "llm_calls",
      "sync_state",
    ]) {
      expect(tables).toContain(name);
    }
    const target = {
      execScript: async (sql: string) => {
        sqlite.run(sql);
      },
      appliedTags: async () =>
        select(`SELECT tag FROM ${MIGRATIONS_TABLE}`).map((r) => String(r.tag)),
    };
    expect(await migrate(target, loadMigrationsFromDisk())).toEqual([]);
  });

  test("a failing migration is rolled back and not recorded", async () => {
    const { sqlite, select } = await makeTestDatabase();
    const target = {
      execScript: async (sql: string) => {
        sqlite.run(sql);
      },
      appliedTags: async () =>
        select(`SELECT tag FROM ${MIGRATIONS_TABLE}`).map((r) => String(r.tag)),
    };
    const bad = [{ tag: "9999_bad", statements: ["CREATE TABLE t1 (x int)", "NOT VALID SQL"] }];
    await expect(migrate(target, bad)).rejects.toThrow();
    const names = select("SELECT name FROM sqlite_master WHERE name = 't1'");
    expect(names).toHaveLength(0);
    expect(select(`SELECT tag FROM ${MIGRATIONS_TABLE} WHERE tag = '9999_bad'`)).toHaveLength(0);
  });
});

describe("drizzle over the proxy", () => {
  test("threads migration turns existing inbox items into one-turn threads", async () => {
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys = ON;");
    const target = {
      execScript: async (sql: string) => {
        sqlite.run(sql);
      },
      appliedTags: async () =>
        (sqlite.query(`SELECT tag FROM ${MIGRATIONS_TABLE}`).all() as { tag: string }[]).map(
          (r) => r.tag,
        ),
    };
    const all = loadMigrationsFromDisk();
    const at = all.findIndex((m) => m.tag.startsWith("0007_"));
    await migrate(target, all.slice(0, at));
    sqlite.run(
      "INSERT INTO inbox_items (id, source, raw_text, received_at, status, summary) VALUES ('i1', 'teams', 'PAY-2 is blocked', '2026-09-24T10:00:00Z', 'triaged', 'PAY-2 blocked'), ('i2', 'email', 'hello', '2026-09-24T11:00:00Z', 'new', NULL)",
    );
    sqlite.run(
      "INSERT INTO proposals (id, inbox_item_id, kind, payload, created_at) VALUES ('p1', 'i1', 'add_comment', '{}', '2026-09-24T10:00:01Z')",
    );
    await migrate(target, all);
    const messages = sqlite
      .query("SELECT id, inbox_item_id, seq, role, content FROM inbox_messages ORDER BY id")
      .all() as { id: string; seq: number; role: string; content: string }[];
    expect(messages.map((m) => [m.id, m.seq, m.role])).toEqual([
      ["a1-i1", 1, "assistant"],
      ["u0-i1", 0, "user"],
      ["u0-i2", 0, "user"],
    ]);
    expect(JSON.parse(messages[1]?.content ?? "")).toEqual({
      parts: [{ type: "pasted", text: "PAY-2 is blocked" }],
    });
    expect(JSON.parse(messages[0]?.content ?? "")).toEqual({ summary: "PAY-2 blocked" });
    expect(sqlite.query("SELECT message_id FROM proposals").get()).toEqual({ message_id: "a1-i1" });
  });

  test("insert, select, get, update and json/boolean columns round-trip", async () => {
    const program = Effect.gen(function* () {
      const teamId = newId();
      yield* query((db) => db.insert(teams).values({ id: teamId, name: "Payments" }));
      yield* query((db) =>
        db.insert(people).values({
          id: newId(),
          displayName: "Ana",
          teamId,
          profile: { tone: "formal", detail: "bullets" },
        }),
      );
      yield* query((db) =>
        db.insert(jiraIssues).values({
          key: "ABC-1",
          id: "10001",
          projectKey: "ABC",
          issueType: "Story",
          summary: "First",
          status: "To Do",
          statusCategory: "new",
          labels: ["x", "y"],
          created: nowIso(),
          updated: nowIso(),
          syncedAt: nowIso(),
        }),
      );
      yield* query((db) => db.insert(issueMeta).values({ issueKey: "ABC-1", pinned: true }));
      const person = yield* query((db) => db.query.people.findFirst());
      const issue = yield* query((db) =>
        db.select().from(jiraIssues).where(eq(jiraIssues.key, "ABC-1")).get(),
      );
      const meta = yield* query((db) => db.select().from(issueMeta).all());
      yield* query((db) =>
        db.update(jiraIssues).set({ summary: "Renamed" }).where(eq(jiraIssues.key, "ABC-1")),
      );
      const renamed = yield* query((db) =>
        db.select({ summary: jiraIssues.summary }).from(jiraIssues).get(),
      );
      const missing = yield* query((db) =>
        db.select().from(jiraIssues).where(eq(jiraIssues.key, "NOPE-1")).get(),
      );
      return { person, issue, meta, renamed, missing };
    });
    const result = await Effect.runPromise(Effect.provide(program, DbTest));
    expect(result.person?.profile).toEqual({ tone: "formal", detail: "bullets" });
    expect(result.issue?.labels).toEqual(["x", "y"]);
    expect(result.issue?.isTrackedEpic).toBe(false);
    expect(result.meta[0]?.pinned).toBe(true);
    expect(result.renamed?.summary).toBe("Renamed");
    expect(result.missing).toBeUndefined();
  });

  test("query failures surface as DbError", async () => {
    const program = query((db) =>
      db.insert(llmCalls).values({
        // Missing NOT NULL columns on purpose.
        id: newId(),
      } as never),
    );
    const exit = await Effect.runPromiseExit(Effect.provide(program, DbTest));
    expect(exit._tag).toBe("Failure");
  });
});

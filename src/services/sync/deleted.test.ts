import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { MIGRATIONS_TABLE, migrate } from "@/db/migrator";
import { deletedIssues, issueMeta, jiraComments, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { DbTest, loadMigrationsFromDisk } from "@/services/db/test";
import {
  clearReopened,
  deletedKeys,
  forgetDeleted,
  recordDeleted,
  sweepDeleted,
  withoutDeleted,
} from "./deleted";

const issue = (key: string, id: string) => ({
  key,
  id,
  projectKey: "PAY",
  issueType: "Task",
  summary: `Summary of ${key}`,
  status: "To Do",
  statusCategory: "new" as const,
  created: "2026-10-01T00:00:00.000+0000",
  updated: "2026-10-01T00:00:00.000+0000",
  syncedAt: "2026-10-01T00:00:00.000Z",
});

describe("tombstones of tickets a revoke deleted (FR-14.6)", () => {
  test("a deleted ticket leaves the cache by key and by id: a moved copy goes too", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          // PAY-1 was moved to OPS-9 (same id); both rows are cached.
          yield* query((d) =>
            d
              .insert(jiraIssues)
              .values([issue("PAY-1", "101"), issue("OPS-9", "101"), issue("PAY-2", "102")]),
          );
          yield* query((d) => d.insert(issueMeta).values({ issueKey: "OPS-9", pinned: true }));
          yield* forgetDeleted("PAY-1", "p1");
          return {
            keys: [...(yield* deletedKeys)].sort(),
            cached: (yield* query((d) => d.select({ key: jiraIssues.key }).from(jiraIssues).all()))
              .map((x) => x.key)
              .sort(),
            meta: yield* query((d) => d.select().from(issueMeta).all()),
          };
        }),
        DbTest,
      ),
    );
    expect(r.keys).toEqual(["OPS-9", "PAY-1"]);
    expect(r.cached).toEqual(["PAY-2"]);
    expect(r.meta).toEqual([]);
  });

  test("a ticket a revoke closed loses its mark once seen reopened", async () => {
    const meta = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const at = "2026-10-15T10:00:00Z";
          yield* query((d) =>
            d
              .insert(issueMeta)
              .values(["PAY-1", "PAY-2", "PAY-3"].map((issueKey) => ({ issueKey, revokedAt: at }))),
          );
          yield* clearReopened([
            { key: "PAY-1", status: "To Do", statusCategory: "new" },
            { key: "PAY-2", status: "Done", statusCategory: "done" },
            // A revoke status outside the done category still counts as closed.
            { key: "PAY-3", status: "Rejected", statusCategory: "indeterminate" },
          ]);
          return yield* query((d) =>
            d.select({ key: issueMeta.issueKey, at: issueMeta.revokedAt }).from(issueMeta).all(),
          );
        }),
        DbTest,
      ),
    );
    expect(meta.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "PAY-1", at: null },
      { key: "PAY-2", at: "2026-10-15T10:00:00Z" },
      { key: "PAY-3", at: "2026-10-15T10:00:00Z" },
    ]);
  });

  test("a sync page drops them, an issue with another id under the key lifts one, a sweep removes strays", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* query((d) =>
            d.insert(jiraIssues).values([issue("PAY-1", "101"), issue("PAY-2", "102")]),
          );
          yield* recordDeleted("PAY-1", "p1");
          yield* recordDeleted("PAY-2", "p2");
          yield* recordDeleted("PAY-3", null);
          const kept = yield* withoutDeleted([
            issue("PAY-1", "101"),
            issue("PAY-2", "999"),
            issue("PAY-3", "103"),
            issue("PAY-4", "104"),
          ]);
          // PAY-1 was written back by a sync racing the revoke.
          yield* query((d) =>
            d.insert(jiraComments).values({
              id: "c1",
              issueKey: "PAY-1",
              body: "x",
              created: "2026-10-01",
              updated: "2026-10-01",
            }),
          );
          yield* query((d) => d.insert(issueMeta).values({ issueKey: "PAY-1", pinned: true }));
          const swept = yield* sweepDeleted;
          return {
            kept: kept.map((i) => i.key),
            keys: [...(yield* deletedKeys)].sort(),
            swept,
            tomb: yield* query((d) =>
              d.select().from(deletedIssues).where(eq(deletedIssues.issueKey, "PAY-1")).get(),
            ),
            cached: (yield* query((d) => d.select({ key: jiraIssues.key }).from(jiraIssues).all()))
              .map((x) => x.key)
              .sort(),
            comments: yield* query((d) => d.select().from(jiraComments).all()),
            meta: yield* query((d) => d.select().from(issueMeta).all()),
          };
        }),
        DbTest,
      ),
    );
    // PAY-2 came back with another id: a different issue, so it is stored.
    expect(r.kept).toEqual(["PAY-2", "PAY-4"]);
    expect(r.keys).toEqual(["PAY-1", "PAY-3"]);
    expect(r.tomb).toMatchObject({ issueKey: "PAY-1", issueId: "101", proposalId: "p1" });
    expect(r.swept).toEqual(["PAY-1"]);
    expect(r.cached).toEqual(["PAY-2"]);
    expect(r.comments).toEqual([]);
    expect(r.meta).toEqual([]);
  });

  test("the migration records tickets revoked before it: deleted ones get a tombstone, closed ones revokedAt", async () => {
    const sqlite = new Database(":memory:");
    const all = loadMigrationsFromDisk();
    const target = {
      execScript: async (sql: string) => {
        sqlite.run(sql);
      },
      appliedTags: async () =>
        (sqlite.query(`SELECT tag FROM ${MIGRATIONS_TABLE}`).all() as { tag: string }[]).map(
          (x) => x.tag,
        ),
    };
    const last = all.findIndex((m) => m.tag.startsWith("0014_"));
    await migrate(target, all.slice(0, last));
    const revoked = (id: string, key: string, revokedRecord: object) =>
      sqlite.run(
        "INSERT INTO proposals (id, kind, payload, status, result, created_at) VALUES (?, 'create_issue', '{}', 'revoked', ?, '2026-10-15T10:00:00Z')",
        [id, JSON.stringify({ issueKey: key, revoked: revokedRecord })],
      );
    revoked("a", "PAY-1", {
      at: "2026-10-15T11:00:00Z",
      message: "Deleted PAY-1",
      ticket: { key: "PAY-1", state: "deleted" },
    });
    // Older records without `ticket` are read from their message.
    revoked("b", "PAY-2", {
      at: "2026-10-15T11:00:00Z",
      message: "Deleted the comment; Deleted PAY-2",
    });
    revoked("c", "PAY-3", { at: "2026-10-15T11:00:00Z", message: "PAY-3 is already deleted." });
    revoked("d", "PAY-4", {
      at: "2026-10-15T12:00:00Z",
      message: "Commented on PAY-4; Moved PAY-4 to Cancelled",
      ticket: { key: "PAY-4", state: "closed", status: "Cancelled", moved: true },
    });
    revoked("e", "PAY-5", { at: "2026-10-15T12:00:00Z", message: "Moved PAY-5 to Cancelled" });
    for (const key of ["PAY-1", "PAY-4"])
      sqlite.run(
        "INSERT INTO jira_issues (key, id, project_key, issue_type, summary, status, status_category, created, updated, synced_at) VALUES (?, '1', 'PAY', 'Task', 's', 'To Do', 'new', 'x', 'x', 'x')",
        [key],
      );
    sqlite.run("INSERT INTO issue_meta (issue_key, pinned) VALUES ('PAY-4', 1)");
    await migrate(target, all);
    const rows = (sql: string) => sqlite.query(sql).all();
    expect(rows("SELECT issue_key, proposal_id FROM deleted_issues ORDER BY issue_key")).toEqual([
      { issue_key: "PAY-1", proposal_id: "a" },
      { issue_key: "PAY-2", proposal_id: "b" },
      { issue_key: "PAY-3", proposal_id: "c" },
    ]);
    expect(rows("SELECT key FROM jira_issues")).toEqual([{ key: "PAY-4" }]);
    expect(rows("SELECT issue_key, pinned, revoked_at FROM issue_meta ORDER BY issue_key")).toEqual(
      [
        { issue_key: "PAY-4", pinned: 1, revoked_at: "2026-10-15T12:00:00Z" },
        { issue_key: "PAY-5", pinned: 0, revoked_at: "2026-10-15T12:00:00Z" },
      ],
    );
  });
});

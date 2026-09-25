import { describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { jiraComments, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { SearchPageSchema } from "@/services/jira";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { json, type StubRequest, stubFetch } from "@/test/stub-fetch";
import { Sync, type SyncError } from ".";
import { SyncLive } from "./live";

type SearchBody = { jql: string; startAt: number; fields: string[]; expand: string[] };

const all = [...page1.issues, ...page2.issues];
const pay3 = all.filter((i) => i.key === "PAY-3");

function setup() {
  // Mutable so a test can drop issues from Jira between runs.
  const state = { mainIssues: all as unknown[] };
  const searches: SearchBody[] = [];
  const page = (issues: unknown[], startAt: number, size: number) => ({
    startAt,
    maxResults: size,
    total: issues.length,
    issues: issues.slice(startAt, startAt + size),
  });
  const stub = stubFetch([
    { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
    { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
    {
      match: (u) => u.pathname.endsWith("/issue/PAY-2/comment"),
      respond: () => json(comments),
    },
    {
      match: (u, r) => u.pathname.endsWith("/search") && r.method === "POST",
      respond: (r: StubRequest) => {
        const body = r.body as SearchBody;
        searches.push(body);
        const source = body.jql.startsWith("(parent in") ? pay3 : state.mainIssues;
        return json(page(source, body.startAt, 3));
      },
    },
  ]);
  const layer = Layer.provideMerge(
    SyncLive,
    jiraTestLayer(stub.fetch, jiraSettings({ trackedEpics: ["PAY-1"] })),
  );
  return { state, searches, seen: stub.seen, layer, fetch: stub.fetch };
}

const ftsKeys = (match: string) =>
  query((db) =>
    db
      .select({ key: jiraIssues.key })
      .from(jiraIssues)
      .where(
        sql`${jiraIssues}.rowid IN (SELECT rowid FROM jira_issues_fts WHERE jira_issues_fts MATCH ${match})`,
      )
      .orderBy(asc(jiraIssues.key))
      .all(),
  );

const issueRows = query((db) => db.select().from(jiraIssues).orderBy(asc(jiraIssues.key)).all());

describe("Sync", () => {
  test("first run is a full sync that pages, stores comments and runs the sub-task pass", async () => {
    const { searches, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const result = yield* sync.run();
          const rows = yield* issueRows;
          const pay2Comments = yield* query((db) =>
            db.select().from(jiraComments).where(eq(jiraComments.issueKey, "PAY-2")).all(),
          );
          const status = yield* sync.status;
          const fts = yield* ftsKeys("ledger*");
          return { result, rows, pay2Comments, status, fts };
        }),
        layer,
      ),
    );
    expect(r.result.full).toBe(true);
    expect(r.rows.map((x) => x.key)).toEqual(["OPS-7", "PAY-1", "PAY-2", "PAY-3", "PAY-4"]);
    expect(r.rows.find((x) => x.key === "PAY-1")?.isTrackedEpic).toBe(true);
    // Two embedded comments plus the third fetched from /comment.
    expect(r.pay2Comments).toHaveLength(3);
    expect(r.status.running).toBe(false);
    expect(r.status.lastFullSyncAt).not.toBeNull();

    const [first, second, subtasks] = searches;
    expect(first?.jql).toContain("cf[10100] in (PAY-1)");
    expect(first?.jql).not.toContain('updated >= "');
    expect(first?.jql).toEndWith("ORDER BY updated ASC");
    expect(first?.expand).toEqual(["renderedFields"]);
    expect(first?.fields).toContain("customfield_10104");
    expect(second?.startAt).toBe(3);
    expect(subtasks?.jql).toStartWith("(parent in (PAY-2, PAY-4))");
    expect(r.fts.map((x) => x.key)).toEqual(["OPS-7", "PAY-2", "PAY-3"]);
  });

  test("the next run is incremental from the watermark in the Jira user's time zone", async () => {
    const { searches, layer } = setup();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          return yield* sync.run();
        }),
        layer,
      ),
    );
    expect(result.full).toBe(false);
    const incremental = searches.filter((s) => s.jql.includes('updated >= "'));
    // Watermark 2026-09-23T08:30Z (PAY-4) minus 5 minutes, shown in Europe/London.
    expect(incremental[0]?.jql).toContain('updated >= "2026/09/23 09:25"');
  });

  test("a forced full resync marks issues Jira no longer returns as stale", async () => {
    const { state, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          state.mainIssues = all.filter((i) => i.key !== "OPS-7");
          const result = yield* sync.run({ full: true });
          return { result, rows: yield* issueRows };
        }),
        layer,
      ),
    );
    expect(r.result.staleMarked).toBe(1);
    expect(r.rows.find((x) => x.key === "OPS-7")?.stale).toBe(true);
    expect(r.rows.find((x) => x.key === "PAY-2")?.stale).toBe(false);
  });

  test("a second concurrent run is rejected as busy", async () => {
    const { layer } = setup();
    const results = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Sync, (sync) =>
          Effect.all([Effect.either(sync.run()), Effect.either(sync.run())], { concurrency: 2 }),
        ),
        layer,
      ),
    );
    const failures = results
      .filter((x) => x._tag === "Left")
      .map((x) => (x.left as SyncError).kind);
    expect(failures).toEqual(["busy"]);
  });

  test("updating an issue in place refreshes the FTS index", async () => {
    const { layer } = setup();
    const hits = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          yield* query((db) =>
            db
              .update(jiraIssues)
              .set({ summary: "Renamed widget" })
              .where(eq(jiraIssues.key, "PAY-4")),
          );
          return yield* ftsKeys("widget");
        }),
        layer,
      ),
    );
    expect(hits.map((h) => h.key)).toEqual(["PAY-4"]);
  });

  test("fixtures are valid search pages", () => {
    expect(() => SearchPageSchema.parse(page1)).not.toThrow();
    expect(() => SearchPageSchema.parse(page2)).not.toThrow();
  });
});

describe("project metadata", () => {
  test("a full sync reads every issue type and status per project for intake validation", async () => {
    const { getState, parseProjectMeta, SYNC_KEYS } = await import("./state");
    const { layer } = setupWithStatuses();
    const meta = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          return parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta));
        }),
        layer,
      ),
    );
    expect(meta.OPS).toEqual({
      issueTypes: ["Sub-task", "Task"],
      statuses: ["Done", "In Progress", "To Do"],
    });
    expect(Object.keys(meta).sort()).toEqual(["OPS", "PAY"]);
  });
});

function setupWithStatuses() {
  const statuses = [
    {
      name: "Task",
      subtask: false,
      statuses: [{ name: "To Do" }, { name: "In Progress" }, { name: "Done" }],
    },
    { name: "Sub-task", subtask: true, statuses: [{ name: "To Do" }, { name: "Done" }] },
  ];
  const base = setup();
  return {
    layer: Layer.provideMerge(
      SyncLive,
      jiraTestLayer(
        async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (/\/project\/[A-Z]+\/statuses$/.test(url.pathname)) return json(statuses);
          return base.fetch(input, init);
        },
        jiraSettings({ trackedEpics: ["PAY-1"] }),
      ),
    ),
  };
}

describe("sprints", () => {
  test("sync stores sprint dates from issues and the board's history (D23)", async () => {
    const { getState, parseSprintState, SYNC_KEYS } = await import("./state");
    const { syncedJiraLayer } = await import("@/test/seed");
    const { layer, seen } = syncedJiraLayer();
    const state = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          return parseSprintState(yield* getState(SYNC_KEYS.sprints));
        }),
        layer,
      ),
    );
    const payments = state.sprints.filter((s) => s.boardId === 7).map((s) => s.name);
    expect(payments).toEqual([
      "Payments 14",
      "Payments 15",
      "Payments 9",
      "Payments 10",
      "Payments 11",
      "Payments 12",
      "Payments 13",
    ]);
    expect(state.sprints.find((s) => s.name === "Payments 15")).toMatchObject({
      state: "active",
      start: "2026-09-14",
      end: "2026-09-28",
    });
    expect(state.completeBoards).toContain(7);
    expect(state.boardProjects["7"]).toEqual(["PAY"]);
    const agile = seen.find((r) => r.url.includes("/rest/agile/1.0/board/7/sprint"));
    expect(new URL(agile?.url ?? "http://x").searchParams.get("state")).toBe(
      "closed,active,future",
    );
  });
});

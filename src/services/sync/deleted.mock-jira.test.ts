/**
 * Sync never writes a ticket a revoke deleted (FR-14.6), over real HTTP against
 * scripts/mock-jira.ts. A trigger in the test database aborts any write of a
 * tombstoned row, so a guard that lets one through fails the sync rather than
 * being hidden by the sweep that follows.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { Sync } from ".";
import { forgetDeleted } from "./deleted";
import { SyncLive } from "./live";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function setup() {
  const issues = generate(60);
  const server = Bun.serve({ port: 0, fetch: createHandler(issues, { laggingSearch: true }) });
  servers.push(server);
  const base = `http://localhost:${server.port}`;
  const searches: string[] = [];
  const layer = Layer.provideMerge(
    SyncLive,
    jiraTestLayer(
      async (input, init) => {
        const req = new Request(input, init);
        if (req.method === "POST" && new URL(req.url).pathname.endsWith("/search"))
          searches.push(String(((await req.clone().json()) as { jql?: string }).jql ?? ""));
        return fetch(req);
      },
      jiraSettings({ baseUrl: base, trackedEpics: [] }),
    ),
  );
  return { issues, layer, base, searches };
}

/** Any insert or update of a tombstoned row aborts the statement. */
const forbidTombstonedWrites = Effect.gen(function* () {
  for (const when of ["INSERT", "UPDATE"])
    yield* query((d) =>
      d.run(
        sql.raw(`CREATE TRIGGER no_tombstoned_${when.toLowerCase()} BEFORE ${when} ON jira_issues
          WHEN NEW.key IN (SELECT issue_key FROM deleted_issues)
          BEGIN SELECT RAISE(ABORT, 'a tombstoned issue was written'); END`),
      ),
    );
});

const cached = (key: string) =>
  query((d) =>
    d.select({ key: jiraIssues.key }).from(jiraIssues).where(eq(jiraIssues.key, key)).get(),
  );

describe("sync never writes a ticket a revoke deleted (FR-14.6)", () => {
  test("full and incremental runs over a search that still returns it", async () => {
    const { issues, layer, base } = setup();
    const victim = [...issues.values()].find(
      (i) => i.type === "Task" && ![...issues.values()].some((x) => x.parent === i.key),
    );
    if (!victim) throw new Error("no task generated");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          // The revoke: Jira deletes it, Secretary forgets it and keeps the tombstone.
          const res = yield* Effect.promise(() =>
            fetch(`${base}/rest/api/2/issue/${victim.key}`, {
              method: "DELETE",
              headers: { authorization: "Bearer test" },
            }),
          );
          yield* forgetDeleted(victim.key, "p1");
          yield* forbidTombstonedWrites;
          const full = yield* sync.run({ full: true });
          const incremental = yield* sync.run();
          return { status: res.status, full, incremental, row: yield* cached(victim.key) };
        }),
        layer,
      ),
    );
    expect(r.status).toBe(204);
    expect(r.full.full).toBe(true);
    expect(r.incremental.full).toBe(false);
    expect(r.row).toBeUndefined();
  });

  test("refreshIssue does not store a tombstoned key, even when Jira still answers", async () => {
    const { issues, layer } = setup();
    const key = [...issues.values()].find((i) => i.type === "Story")?.key ?? "";
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          yield* forgetDeleted(key, "p1");
          yield* forbidTombstonedWrites;
          yield* sync.refreshIssue(key);
          return yield* cached(key);
        }),
        layer,
      ),
    );
    expect(r).toBeUndefined();
  });

  test("a tombstoned parent epic is not read again", async () => {
    const { issues, layer, searches } = setup();
    const all = [...issues.values()];
    // An epic with children, that no issue is blocked by (the blocker check reads by key too).
    const epic = all.find(
      (i) =>
        i.type === "Epic" &&
        all.some((x) => x.epic === i.key) &&
        !all.some((x) => x.links.some((l) => l.inward === i.key)),
    );
    if (!epic) throw new Error("no epic with children generated");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          yield* forgetDeleted(epic.key, "p1");
          const children = yield* query((d) =>
            d
              .select({ key: jiraIssues.key })
              .from(jiraIssues)
              .where(eq(jiraIssues.epicKey, epic.key))
              .all(),
          );
          searches.length = 0;
          yield* sync.run();
          return { children: children.length, row: yield* cached(epic.key) };
        }),
        layer,
      ),
    );
    expect(r.children).toBeGreaterThan(0);
    expect(searches.filter((j) => j.startsWith("key in") && j.includes(epic.key))).toEqual([]);
    expect(r.row).toBeUndefined();
  });
});

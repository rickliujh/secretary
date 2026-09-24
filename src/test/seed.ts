/** Shared test setup: a DB synced from the Jira fixtures, via the real Sync service. */
import { Effect, Layer } from "effect";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";

export const fixtureIssues = [...page1.issues, ...page2.issues];

/** JiraClient + Sync over a stub serving the fixtures; `extra` routes take precedence. */
export function syncedJiraLayer(extra: StubRoute[] = []) {
  const stub = stubFetch([
    ...extra,
    { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
    { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
    {
      match: (u, r) => u.pathname.endsWith("/comment") && r.method === "GET",
      respond: () => json(comments),
    },
    {
      match: (u) => u.pathname.endsWith("/search"),
      respond: (r) => {
        const b = r.body as { startAt: number; jql: string };
        const src = b.jql.startsWith("(parent in") ? [] : fixtureIssues;
        return json({
          startAt: b.startAt,
          maxResults: 100,
          total: src.length,
          issues: src.slice(b.startAt),
        });
      },
    },
  ]);
  const layer = Layer.provideMerge(
    SyncLive,
    jiraTestLayer(stub.fetch, jiraSettings({ trackedEpics: ["PAY-1"] })),
  );
  return { layer, seen: stub.seen };
}

export const syncOnce = Effect.flatMap(Sync, (s) => s.run());

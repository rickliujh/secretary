/** Shared test setup: a DB synced from the Jira fixtures, via the real Sync service. */
import { Effect, Layer } from "effect";
import type { AppSettings } from "@/services/settings/schema";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import boardSprints from "@/test/fixtures/jira/board-7-sprints.json";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";

export const fixtureIssues = [...page1.issues, ...page2.issues];

/** Issue types and statuses per project, as `/project/{KEY}/statuses` returns them. */
function projectStatuses(projectKey: string) {
  const statuses = (names: string[]) => names.map((name) => ({ name }));
  return projectKey === "PAY"
    ? ["Epic", "Story", "Task", "Bug", "Sub-task"].map((name) => ({
        name,
        statuses: statuses(["To Do", "In Progress", "Blocked", "In Review", "Done"]),
      }))
    : ["Task", "Sub-task"].map((name) => ({
        name,
        statuses: statuses(["To Do", "In Progress", "Done"]),
      }));
}

export type FixtureOptions = {
  /**
   * Serve `/project/{KEY}/statuses` (default true). Off, sync stores no project
   * metadata, so retrieval falls back to what the cache holds.
   */
  projectStatuses?: boolean;
};

/** Stub routes for a Jira instance holding the fixture issues, as a real sync reads them. */
export function fixtureRoutes({ projectStatuses: withStatuses = true }: FixtureOptions = {}) {
  const routes: StubRoute[] = [
    { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
    { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
    {
      match: (u) => u.pathname.endsWith("/rest/agile/1.0/board/7/sprint"),
      respond: () => json(boardSprints),
    },
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
  ];
  if (withStatuses)
    routes.push({
      match: (u) => /\/project\/[A-Z][A-Z0-9_]*\/statuses$/.test(u.pathname),
      respond: (r) => json(projectStatuses(r.url.pathname.split("/").at(-2) ?? "")),
    });
  return routes;
}

/** JiraClient + Sync over a stub serving the fixtures; `extra` routes take precedence. */
export function syncedJiraLayer(
  extra: StubRoute[] = [],
  patch: Partial<AppSettings> = {},
  options: FixtureOptions = {},
) {
  const stub = stubFetch([...extra, ...fixtureRoutes(options)]);
  const layer = Layer.provideMerge(
    SyncLive,
    jiraTestLayer(stub.fetch, { ...jiraSettings({ trackedEpics: ["PAY-1"] }), ...patch }),
  );
  return { layer, seen: stub.seen };
}

export const syncOnce = Effect.flatMap(Sync, (s) => s.run());

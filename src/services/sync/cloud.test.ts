/** Jira Cloud (design.md D19): Basic auth, search/jql token paging, account IDs, parent epics. */
import { describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { Executor } from "@/services/executor";
import { ExecutorLive } from "@/services/executor/live";
import { makeFetcherTest } from "@/services/http";
import { JiraClientLive } from "@/services/jira/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import fields from "@/test/fixtures/jira/field.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { json, noContent, stubFetch } from "@/test/stub-fetch";
import { Sync } from ".";
import { SyncLive } from "./live";

const SITE = "https://acme.atlassian.net";

/** Cloud users have accountId and no name. */
function cloudify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloudify);
  if (value && typeof value === "object") {
    const o = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloudify(v)])) as Record<
      string,
      unknown
    >;
    if (
      typeof o.displayName === "string" &&
      typeof o.name === "string" &&
      !("statusCategory" in o)
    ) {
      o.accountId = `acc-${o.name}`;
      delete o.name;
      delete o.key;
    }
    return o;
  }
  return value;
}

const issues = cloudify([...page1.issues, ...page2.issues]) as { key: string }[];

function setup() {
  const stub = stubFetch([
    {
      match: (u) => u.pathname === "/rest/api/2/myself",
      respond: () =>
        json({ accountId: "acc-rliu", displayName: "Rick Liu", timeZone: "Europe/London" }),
    },
    {
      match: (u) => u.pathname === "/rest/api/2/field",
      respond: () => json(fields.filter((f) => f.id !== "customfield_10100")),
    },
    {
      match: (u) => u.pathname === "/rest/api/2/search",
      respond: () => json({ errorMessages: ["The requested API has been removed."] }, 410),
    },
    {
      match: (u) => u.pathname === "/rest/api/2/search/jql",
      respond: (r) => {
        const b = r.body as { nextPageToken?: string; maxResults: number; jql: string };
        if (b.jql.startsWith("(parent in")) return json({ issues: [], isLast: true });
        const start = b.nextPageToken ? Number(b.nextPageToken.replace("tok-", "")) : 0;
        const pageIssues = issues.slice(start, start + 3);
        const done = start + 3 >= issues.length;
        return json({
          issues: pageIssues,
          ...(done ? { isLast: true } : { nextPageToken: `tok-${start + 3}`, isLast: false }),
        });
      },
    },
    {
      match: (u) => u.pathname.endsWith("/comment"),
      respond: () => json({ startAt: 0, maxResults: 100, total: 0, comments: [] }),
    },
    {
      match: (u, r) => u.pathname.endsWith("/assignee") && r.method === "PUT",
      respond: () => noContent(),
    },
    {
      match: (u, r) => /\/issue\/[A-Z]+-\d+$/.test(u.pathname) && r.method === "PUT",
      respond: () => noContent(),
    },
    {
      match: (u, r) => /\/issue\/PAY-4$/.test(u.pathname) && r.method === "GET",
      respond: () => json(issues.find((i) => i.key === "PAY-4")),
    },
  ]);
  const s = defaultSettings();
  const base = Layer.mergeAll(
    makeSettingsTest({
      ...s,
      jira: {
        ...s.jira,
        baseUrl: `${SITE}/jira`,
        email: "rick@example.com",
        trackedEpics: ["PAY-1"],
      },
    }),
    makeSecretsTest({ [secretNames.jiraPat]: "api-token-000000" }),
    makeFetcherTest(stub.fetch),
    DbTest,
  );
  const layer = Layer.provideMerge(
    ExecutorLive,
    Layer.provideMerge(SyncLive, Layer.provideMerge(JiraClientLive, base)),
  );
  return { layer, seen: stub.seen };
}

describe("Jira Cloud", () => {
  test("sync uses search/jql with page tokens, Basic auth at the site root, and account IDs", async () => {
    const { layer, seen } = setup();
    const rows = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          return yield* query((d) =>
            d.select().from(jiraIssues).orderBy(asc(jiraIssues.key)).all(),
          );
        }),
        layer,
      ),
    );
    expect(rows.map((r) => r.key)).toEqual(["OPS-7", "PAY-1", "PAY-2", "PAY-3", "PAY-4"]);
    expect(rows.find((r) => r.key === "PAY-2")?.assignee).toBe("acc-ana.b");
    const searches = seen.filter((x) => x.url === `${SITE}/rest/api/2/search/jql`);
    expect(searches[0]?.body).toMatchObject({ maxResults: 100, expand: "renderedFields" });
    expect(searches[0]?.body).not.toHaveProperty("nextPageToken");
    expect(searches[1]?.body).toMatchObject({ nextPageToken: "tok-3" });
    // No Epic Link clause on Cloud; parent covers epics.
    expect((searches[0]?.body as { jql: string }).jql).toContain("parent in (PAY-1)");
    expect((searches[0]?.body as { jql: string }).jql).not.toContain("cf[");
    expect(seen.some((x) => x.url.endsWith("/rest/api/2/search"))).toBe(false);
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${btoa("rick@example.com:api-token-000000")}`,
    );
    expect(seen.every((x) => !x.url.includes("/jira/rest"))).toBe(true);
  });

  test("assign uses accountId; epics are set and removed through parent", async () => {
    const { layer, seen } = setup();
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ex = yield* Executor;
          yield* ex.run({ kind: "assign", issueKey: "PAY-4", username: "acc-ana.b" });
          yield* ex.run({ kind: "set_epic", issueKey: "PAY-4", epicKey: "PAY-1" });
          yield* ex.run({ kind: "set_epic", issueKey: "PAY-4", epicKey: null });
        }),
        layer,
      ),
    );
    const puts = seen.filter((x) => x.method === "PUT").map((x) => x.body);
    expect(puts).toEqual([
      { accountId: "acc-ana.b" },
      { fields: { parent: { key: "PAY-1" } } },
      { update: { parent: [{ set: { none: true } }] } },
    ]);
    // No editmeta lookup on Cloud.
    expect(seen.some((x) => x.url.endsWith("/editmeta"))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeFetcherTest } from "@/services/http";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import dcIssue from "@/test/fixtures/jira/issue-PAY-2-changelog.json";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";
import { JiraClient } from ".";
import { JiraClientLive } from "./live";

function history(routes: StubRoute[], baseUrl: string, key: string, since: string) {
  const stub = stubFetch(routes);
  const settings = defaultSettings();
  const layer = JiraClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeSettingsTest({
          ...settings,
          jira: { ...settings.jira, baseUrl, email: "rick@example.com" },
        }),
        makeSecretsTest({ [secretNames.jiraPat]: "stored-pat-123456" }),
        makeFetcherTest(stub.fetch),
      ),
    ),
  );
  const result = Effect.runPromise(
    Effect.provide(
      Effect.flatMap(JiraClient, (c) => c.issueHistory(key, since)),
      layer,
    ),
  );
  return { result, seen: stub.seen };
}

describe("JiraClient.issueHistory on Data Center", () => {
  test("reads the expanded changelog, maps usernames and dates, drops older entries", async () => {
    const { result, seen } = history(
      [
        {
          match: (url) => url.pathname === "/jira/rest/api/2/issue/PAY-2",
          respond: () => json(dcIssue),
        },
      ],
      "https://jira.example.com/jira",
      "PAY-2",
      "2026-09-15T00:00:00.000Z",
    );
    const changes = await result;
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]?.url ?? "");
    expect(url.searchParams.get("expand")).toBe("changelog");
    expect(url.searchParams.get("fields")).toBe("summary");
    expect(changes).toEqual([
      {
        at: "2026-09-21T15:40:12.000Z",
        author: "ana.b",
        authorDisplay: "Ana Bell",
        items: [
          { field: "status", from: "In Progress", to: "Blocked", fromId: "3", toId: "10400" },
          { field: "resolution", from: null, to: null, fromId: null, toId: null },
        ],
      },
      {
        at: "2026-09-22T08:15:00.000Z",
        author: null,
        authorDisplay: null,
        // A missing `toString` stays null rather than picking up Object.prototype.toString.
        items: [{ field: "assignee", from: "Ana Bell", to: null, fromId: "ana.b", toId: "tom.k" }],
      },
    ]);
  });
});

describe("JiraClient.issueHistory on Cloud", () => {
  const HOUR = 3_600_000;
  const base = Date.UTC(2026, 8, 1, 8);
  /** Jira's format with a +0200 offset, `i` hours after `base`. */
  const jiraTime = (i: number) =>
    new Date(base + i * HOUR + 2 * HOUR).toISOString().replace("Z", "+0200");
  const entries = (total: number) =>
    Array.from({ length: total }, (_, i) => ({
      id: String(1000 + i),
      author: { accountId: `acc-${i % 3}`, displayName: `User ${i % 3}`, active: true },
      created: jiraTime(i),
      items: [
        {
          field: "status",
          fieldtype: "jira",
          from: "1",
          fromString: "To Do",
          to: "3",
          toString: "In Progress",
        },
      ],
    }));
  const changelogRoute = (all: ReturnType<typeof entries>): StubRoute => ({
    match: (url) => url.pathname === "/rest/api/2/issue/PAY-7/changelog",
    respond: (req) => {
      const startAt = Number(req.url.searchParams.get("startAt"));
      const max = Math.min(Number(req.url.searchParams.get("maxResults")), 100);
      const values = all.slice(startAt, startAt + max);
      return json({
        startAt,
        maxResults: max,
        total: all.length,
        isLast: startAt + values.length >= all.length,
        values,
      });
    },
  });
  const pages = (seen: { url: string }[]) =>
    seen.map((s) => {
      const u = new URL(s.url);
      return `${u.pathname}?${u.searchParams.toString()}`;
    });
  const since = (i: number) => new Date(base + i * HOUR).toISOString();

  test("walks back from the newest page and stops at the page that starts before since", async () => {
    const { result, seen } = history(
      [changelogRoute(entries(250))],
      "https://acme.atlassian.net",
      "PAY-7",
      since(120),
    );
    const changes = await result;
    expect(pages(seen)).toEqual([
      "/rest/api/2/issue/PAY-7/changelog?startAt=0&maxResults=100",
      "/rest/api/2/issue/PAY-7/changelog?startAt=150&maxResults=100",
      "/rest/api/2/issue/PAY-7/changelog?startAt=100&maxResults=50",
    ]);
    expect(seen[0]?.headers.authorization).toStartWith("Basic ");
    expect(changes).toHaveLength(130);
    expect(changes[0]).toEqual({
      at: since(120),
      author: "acc-0",
      authorDisplay: "User 0",
      items: [{ field: "status", from: "To Do", to: "In Progress", fromId: "1", toId: "3" }],
    });
    expect(changes.at(-1)?.at).toBe(since(249));
    const times = changes.map((c) => c.at);
    expect([...times].sort()).toEqual(times);
  });

  test("a short history is one request; an early since reuses the first page", async () => {
    const short = history(
      [changelogRoute(entries(40))],
      "https://acme.atlassian.net",
      "PAY-7",
      since(35),
    );
    expect((await short.result).map((c) => c.at)).toEqual([35, 36, 37, 38, 39].map(since));
    expect(short.seen).toHaveLength(1);

    const all = history(
      [changelogRoute(entries(150))],
      "https://acme.atlassian.net",
      "PAY-7",
      since(-1),
    );
    const changes = await all.result;
    expect(pages(all.seen)).toEqual([
      "/rest/api/2/issue/PAY-7/changelog?startAt=0&maxResults=100",
      "/rest/api/2/issue/PAY-7/changelog?startAt=100&maxResults=50",
    ]);
    expect(changes).toHaveLength(150);
    expect(new Set(changes.map((c) => c.at)).size).toBe(150);
  });
});

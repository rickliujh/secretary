/**
 * End-to-end over real HTTP: the real JiraClient, Sync and Executor against
 * scripts/mock-jira.ts. Mirrors the Phase 1 checklist without a Jira instance.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { jiraComments, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { Executor } from "@/services/executor";
import { ExecutorLive } from "@/services/executor/live";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { Sync } from ".";
import { SyncLive } from "./live";

const issues = generate(120);
const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
afterAll(() => server.stop(true));

const layer = Layer.provideMerge(
  ExecutorLive,
  Layer.provideMerge(
    SyncLive,
    jiraTestLayer(
      (input, init) => fetch(input, init),
      jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: ["PAY-1"] }),
    ),
  ),
);

const row = (key: string) =>
  query((db) => db.select().from(jiraIssues).where(eq(jiraIssues.key, key)).get());

describe("sync and executor against the mock Jira", () => {
  test("full sync, incremental pick-up of a Jira-side change, and a comment round trip", async () => {
    const story = [...issues.values()].find((i) => i.type === "Story");
    if (!story) throw new Error("no story generated");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const first = yield* sync.run();
          const count = (yield* query((db) =>
            db.select({ key: jiraIssues.key }).from(jiraIssues).all(),
          )).length;

          // Someone edits the story in Jira.
          story.summary = "Changed in Jira";
          story.updated = new Date().toISOString().replace("Z", "+0000");
          const second = yield* sync.run();
          const changed = yield* row(story.key);

          // The user comments from the app.
          yield* (yield* Executor).run({
            kind: "add_comment",
            issueKey: story.key,
            bodyMarkdown: "**Chased** Ana",
          });
          const stored = yield* query((db) =>
            db.select().from(jiraComments).where(eq(jiraComments.issueKey, story.key)).all(),
          );
          return { first, second, count, changed, stored };
        }),
        layer,
      ),
    );
    expect(r.first.full).toBe(true);
    expect(r.count).toBe(issues.size);
    expect(r.second.full).toBe(false);
    expect(r.second.fetched).toBeGreaterThanOrEqual(1);
    expect(r.second.fetched).toBeLessThan(issues.size);
    expect(r.changed?.summary).toBe("Changed in Jira");
    // Jira received wiki markup and the cache shows Jira's version.
    expect(story.comments.at(-1)?.body).toBe("*Chased* Ana");
    expect(r.stored.at(-1)?.body).toBe("*Chased* Ana");
    expect(r.stored).toHaveLength(story.comments.length);
  });
});

describe("proposals against the mock Jira", () => {
  test("an approved create_issue proposal creates the issue under its epic", async () => {
    const { ProposalsLive } = await import("@/services/proposals/live");
    const { Proposals } = await import("@/services/proposals");
    const { inboxItems, proposals } = await import("@/db/schema");
    const created = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          yield* query((d) =>
            d.insert(inboxItems).values({
              id: "in1",
              source: "typed",
              rawText: "x",
              receivedAt: "2026-09-24T00:00:00Z",
            }),
          );
          yield* query((d) =>
            d.insert(proposals).values({
              id: "p1",
              inboxItemId: "in1",
              kind: "create_issue",
              payload: {
                kind: "create_issue",
                ref: "$new:1",
                projectKey: "PAY",
                issueType: "Story",
                summary: "Export credit notes",
                descriptionMd: null,
                parent: null,
                epic: "PAY-1",
                priority: null,
                assignee: null,
                dueDate: null,
              },
              createdAt: "2026-09-24T00:00:00Z",
            }),
          );
          const result = yield* (yield* Proposals).approve("p1");
          const stored = yield* row(result.issueKey ?? "");
          return { result, row: stored };
        }),
        Layer.provideMerge(ProposalsLive, layer),
      ),
    );
    expect(created.result.status).toBe("executed");
    expect(created.row?.epicKey).toBe("PAY-1");
    expect(issues.get(created.result.issueKey ?? "")?.summary).toBe("Export credit notes");
  });
});

describe("dependency mirroring against the mock Jira", () => {
  test("mirroring shows the dependency on the issue; resolving updates it; turning off removes it", async () => {
    const deps = await import("@/services/dependencies/queries");
    const story = [...issues.values()].find((i) => i.type === "Story");
    if (!story) throw new Error("no story");
    const states = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const id = yield* deps.createDependency({
            issueKey: story.key,
            kind: "incident",
            label: "Platform fix",
            externalRef: "INC0012345",
            externalUrl: "https://snow.example.com/INC0012345",
          });
          yield* deps.mirror(id, true);
          const afterOn = structuredClone(story.remoteLinks);
          yield* deps.setStatus(id, "resolved");
          const afterResolve = structuredClone(story.remoteLinks);
          yield* deps.mirror(id, false);
          return { afterOn, afterResolve, afterOff: story.remoteLinks };
        }),
        layer,
      ),
    );
    expect(states.afterOn).toHaveLength(1);
    expect(states.afterOn?.[0]?.object).toMatchObject({
      title: "Waiting on Platform fix (INC0012345)",
      status: { resolved: false },
    });
    expect(states.afterResolve).toHaveLength(1);
    expect(states.afterResolve?.[0]?.object.status).toEqual({ resolved: true });
    expect(states.afterOff).toEqual([]);
  });
});

describe("dashboard over 2,000 synced issues", () => {
  test("loads and builds within the 1 second budget (FR-5 AC)", async () => {
    const { buildDashboard } = await import("@/services/dashboard/sections");
    const { loadDashboardInputs } = await import("@/services/dashboard/data");
    const { DEFAULT_WEIGHTS } = await import("@/services/settings/schema");
    const big = generate(2000);
    const bigServer = Bun.serve({ port: 0, fetch: createHandler(big) });
    try {
      const bigLayer = Layer.provideMerge(
        SyncLive,
        jiraTestLayer(
          (input, init) => fetch(input, init),
          jiraSettings({
            baseUrl: `http://localhost:${bigServer.port}`,
            trackedEpics: ["PAY-1", "PAY-2", "OPS-1"],
          }),
        ),
      );
      const r = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* (yield* Sync).run();
            const started = performance.now();
            const inputs = yield* loadDashboardInputs(new Date("2026-09-24T09:00:00Z"));
            const d = buildDashboard(inputs, DEFAULT_WEIGHTS, "2026-09-24", "2026-09-24T09:00:00Z");
            return {
              ms: performance.now() - started,
              issues: inputs.issues.length,
              focus: d.topFocus.length,
            };
          }),
          bigLayer,
        ),
      );
      expect(r.issues).toBe(2000);
      expect(r.focus).toBe(10);
      console.log(`dashboard over ${r.issues} issues: ${r.ms.toFixed(0)} ms`);
      expect(r.ms).toBeLessThan(1000);
    } finally {
      bigServer.stop(true);
    }
  }, 60_000);
});

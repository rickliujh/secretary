import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { actionsLog, jiraComments, jiraIssues, people, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { query } from "@/services/db";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import editmeta from "@/test/fixtures/jira/editmeta-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import { jiraTestLayer } from "@/test/layers";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";
import { Executor, type ExecutorError } from ".";
import { ExecutorLive } from "./live";

const pay2 = page1.issues.find((i) => i.key === "PAY-2");
if (!pay2) throw new Error("fixture");

function setup(extra: StubRoute[] = []) {
  let summary = pay2?.fields.summary ?? "";
  let sprintField: unknown = pay2?.fields.customfield_10104;
  const stub = stubFetch([
    ...extra,
    { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
    { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
    { match: (u) => u.pathname.endsWith("/issue/PAY-2/editmeta"), respond: () => json(editmeta) },
    {
      match: (u) => u.pathname.endsWith("/issue/PAY-2/comment"),
      respond: (r) =>
        r.method === "POST"
          ? json(
              {
                id: "50004",
                body: (r.body as { body: string }).body,
                created: "2026-09-23T10:00:00.000+0100",
                updated: "2026-09-23T10:00:00.000+0100",
              },
              201,
            )
          : json(comments),
    },
    {
      match: (u, r) => u.pathname.endsWith("/issue/PAY-2") && r.method === "PUT",
      respond: (r) => {
        const f = (r.body as { fields: { summary?: string } }).fields;
        if (f.summary) summary = f.summary;
        return new Response(null, { status: 204 });
      },
    },
    {
      match: (u, r) => u.pathname.endsWith("/issue/PAY-2") && r.method === "GET",
      respond: () =>
        json({
          ...pay2,
          fields: {
            ...pay2?.fields,
            summary,
            customfield_10104: sprintField,
            updated: "2026-09-23T10:00:00.000+0100",
          },
        }),
    },
    {
      // Jira Software moves the issue out of its open sprint into the target.
      match: (u, r) => u.pathname === "/rest/agile/1.0/sprint/44/issue" && r.method === "POST",
      respond: () => {
        sprintField = [{ id: 44, name: "Payments 16", state: "future", boardId: 7 }];
        return new Response(null, { status: 204 });
      },
    },
  ]);
  const layer = Layer.provideMerge(
    ExecutorLive,
    Layer.provideMerge(SyncLive, jiraTestLayer(stub.fetch)),
  );
  return { seen: stub.seen, layer };
}

const logs = query((db) => db.select().from(actionsLog).all());

describe("Executor", () => {
  test("a field update writes, logs, and stores Jira's re-fetched version", async () => {
    const { seen, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).discoverFields;
          const result = yield* (yield* Executor).run({
            kind: "update_fields",
            issueKey: "PAY-2",
            fields: { summary: "Export invoices (v2)" },
          });
          const row = yield* query((db) =>
            db.select().from(jiraIssues).where(eq(jiraIssues.key, "PAY-2")).get(),
          );
          const stored = yield* query((db) =>
            db.select().from(jiraComments).where(eq(jiraComments.issueKey, "PAY-2")).all(),
          );
          return { result, row, stored, log: yield* logs };
        }),
        layer,
      ),
    );
    expect(r.result.refreshed).toBe(true);
    expect(r.row?.summary).toBe("Export invoices (v2)");
    // The re-fetch filled in the comment Jira had not embedded.
    expect(r.stored).toHaveLength(3);
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toMatchObject({ action: "update_fields", target: "PAY-2", ok: true });
    const put = seen.find((s) => s.method === "PUT");
    expect(put?.body).toEqual({ fields: { summary: "Export invoices (v2)" } });
    // The PAT never reaches the audit log.
    expect(JSON.stringify(r.log)).not.toContain("test-pat-000000");
  });

  test("set_epic reads edit metadata and writes the Epic Link field", async () => {
    const { seen, layer } = setup();
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).discoverFields;
          yield* (yield* Executor).run({ kind: "set_epic", issueKey: "PAY-2", epicKey: "PAY-1" });
        }),
        layer,
      ),
    );
    expect(seen.find((s) => s.method === "PUT")?.body).toEqual({
      fields: { customfield_10100: "PAY-1" },
    });
  });

  test("a rejected write is logged as failed and surfaces the Jira error", async () => {
    const { layer } = setup([
      {
        match: (u, r) => u.pathname.endsWith("/issue/PAY-2/transitions") && r.method === "POST",
        respond: () =>
          json(
            {
              errorMessages: [
                "It seems that you have tried to perform an illegal workflow operation.",
              ],
              errors: {},
            },
            400,
          ),
      },
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const exit = yield* Effect.either(
            (yield* Executor).run({ kind: "transition", issueKey: "PAY-2", transitionId: "99" }),
          );
          return { exit, log: yield* logs };
        }),
        layer,
      ),
    );
    expect(r.exit._tag).toBe("Left");
    expect(r.log[0]).toMatchObject({ action: "transition", ok: false });
    expect(JSON.stringify(r.log[0]?.response)).toContain("illegal workflow operation");
  });

  test("invalid actions are rejected before any request", async () => {
    const { seen, layer } = setup();
    const exit = await Effect.runPromise(
      Effect.provide(
        Effect.either(
          Effect.flatMap(Executor, (e) =>
            e.run({ kind: "add_comment", issueKey: "not-a-key", bodyMarkdown: "x" }),
          ),
        ),
        layer,
      ),
    );
    expect(exit._tag === "Left" && (exit.left as ExecutorError).kind).toBe("invalid");
    expect(seen).toHaveLength(0);
  });

  test("an appended contact note is stamped with the local date", async () => {
    const { layer } = setup();
    const row = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* query((d) =>
            d.insert(people).values({ id: "p1", displayName: "Ana B", notesMd: "Met in June" }),
          );
          yield* query((d) =>
            d.insert(proposals).values({
              id: "prop1",
              seq: 0,
              kind: "update_person",
              payload: {},
              status: "approved",
              createdAt: "2026-09-23T10:00:00.000Z",
            }),
          );
          yield* Effect.flatMap(Executor, (e) =>
            e.runProposal(
              { kind: "update_person", personId: "p1", changes: {}, noteAppend: "Prefers email" },
              { proposalId: "prop1", inboxItemId: null },
            ),
          );
          return yield* query((d) => d.select().from(people).where(eq(people.id, "p1")).get());
        }),
        layer,
      ),
    );
    expect(row?.notesMd).toBe(`Met in June\n\n- ${localDate()}: Prefers email`);
  });

  test("move_to_sprint posts to the Agile API, re-fetches, logs, and is idempotent", async () => {
    const { seen, layer } = setup();
    const move = {
      kind: "move_to_sprint",
      target: "PAY-2",
      sprintId: 44,
      sprintName: "Payments 16",
    } as const;
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.discoverFields;
          yield* sync.refreshIssue("PAY-2");
          const sprintRow = () =>
            query((db) =>
              db
                .select({ sprint: jiraIssues.sprint, points: jiraIssues.storyPoints })
                .from(jiraIssues)
                .where(eq(jiraIssues.key, "PAY-2"))
                .get(),
            );
          const before = yield* sprintRow();
          yield* query((d) =>
            d.insert(proposals).values({
              id: "move1",
              seq: 0,
              kind: "move_to_sprint",
              payload: move,
              status: "approved",
              createdAt: "2026-09-26T10:00:00.000Z",
            }),
          );
          const executor = yield* Executor;
          const first = yield* executor.runProposal(move, {
            proposalId: "move1",
            inboxItemId: null,
          });
          const after = yield* sprintRow();
          const again = yield* executor.runProposal(move, {
            proposalId: "move1",
            inboxItemId: null,
          });
          return { before, first, after, again, log: yield* logs };
        }),
        layer,
      ),
    );
    expect(r.before).toEqual({ sprint: "Payments 15", points: 5 });
    expect(r.first).toEqual({ message: "Moved PAY-2 to sprint Payments 16", issueKey: "PAY-2" });
    expect(r.after?.sprint).toBe("Payments 16");
    const posts = seen.filter((x) => x.url.includes("/rest/agile/1.0/sprint/"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: "https://jira.example.com/rest/agile/1.0/sprint/44/issue",
      method: "POST",
      body: { issues: ["PAY-2"] },
    });
    // The second approval found the cache already in the sprint and wrote nothing.
    expect(r.again).toEqual({
      message: "PAY-2 is already in sprint Payments 16",
      issueKey: "PAY-2",
    });
    expect(r.log.map((l) => [l.action, l.target, l.ok, l.proposalId])).toEqual([
      ["move_to_sprint", "PAY-2", true, "move1"],
      ["move_to_sprint", "PAY-2", true, "move1"],
    ]);
    expect(r.log[0]?.request).toMatchObject({ api: "agile", path: "sprint/44/issue" });
    expect(r.log[1]?.response).toEqual({ skipped: "already in sprint" });
  });
});

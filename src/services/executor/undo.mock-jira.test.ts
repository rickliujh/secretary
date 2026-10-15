/**
 * Undo data (D54 (1)) recorded by the Jira kinds, read from Jira just before the
 * write, against scripts/mock-jira.ts. Comments and sprint moves are covered in
 * executor.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { proposals } from "@/db/schema";
import { query } from "@/services/db";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { Executor, type ProposalResult } from ".";
import { ExecutorLive } from "./live";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function setup() {
  const issues = generate(30);
  const [a, b] = [...issues.values()].filter((i) => i.type === "Story" && i.links.length === 0);
  if (!a || !b) throw new Error("fixture");
  a.status = "To Do";
  a.priority = "Low";
  a.due = null;
  a.assignee = { name: "tom.k", displayName: "Tom Kay", emailAddress: "tom@example.com" };
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const layer = Layer.provideMerge(
    ExecutorLive,
    Layer.provideMerge(
      SyncLive,
      jiraTestLayer(
        (input, init) => fetch(input, init),
        jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
      ),
    ),
  );
  return { a, b, layer };
}

const approve = (payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    yield* query((d) =>
      d.insert(proposals).values({
        id: "p1",
        seq: 0,
        kind: String(payload.kind),
        payload,
        status: "approved",
        createdAt: "2026-10-15T08:00:00.000Z",
      }),
    );
    return yield* (yield* Executor).runProposal(ProposalPayloadSchema.parse(payload), {
      proposalId: "p1",
      inboxItemId: null,
    });
  });

const runIt = (layer: Layer.Layer<Executor | Sync, unknown>, payload: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        return yield* approve(payload);
      }),
      layer,
    ) as Effect.Effect<ProposalResult, unknown, never>,
  );

describe("undo recorded by the Jira kinds (mock Jira)", () => {
  test("update_issue: the values it replaced and the values it set", async () => {
    const { a, layer } = setup();
    const r = await runIt(layer, {
      kind: "update_issue",
      target: a.key,
      changes: { priority: "High", dueDate: "2026-10-30", assignee: "me" },
    });
    expect(r.undo).toEqual({
      kind: "update_issue",
      issueKey: a.key,
      before: { priority: "Low", dueDate: null, assignee: "tom.k" },
      after: { priority: "High", dueDate: "2026-10-30", assignee: "me" },
      // The replaced assignee's name, for the revoke's texts.
      names: { "tom.k": "Tom Kay" },
    });
  });

  test("transition_issue: the status it left and the one it reached", async () => {
    const { a, layer } = setup();
    const r = await runIt(layer, {
      kind: "transition_issue",
      target: a.key,
      toStatus: "In Progress",
    });
    expect(r.undo).toEqual({
      kind: "transition_issue",
      issueKey: a.key,
      fromStatus: "To Do",
      toStatus: "In Progress",
    });
  });

  test("link_issues: the id of the link it made", async () => {
    const { a, b, layer } = setup();
    const r = await runIt(layer, { kind: "link_issues", target: a.key, blocker: b.key });
    expect(r.undo).toMatchObject({ kind: "link_issues", issueKey: a.key });
    expect((r.undo as { linkId: string | null }).linkId).toMatch(/^\d+$/);
  });
});

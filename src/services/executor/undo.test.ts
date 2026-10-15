/** Undo data (D54 (1)): the pure readers and what local kinds record. */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { proposals } from "@/db/schema";
import { type Db, query } from "@/services/db";
import { createDependency } from "@/services/dependencies/queries";
import { createPerson, createTeam } from "@/services/directory/queries";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { syncedJiraLayer } from "@/test/seed";
import { Executor } from ".";
import { ExecutorLive } from "./live";
import { issueFieldValues, issueStatus, openSprint, undoOf } from "./undo";

describe("undo readers", () => {
  test("issue fields become comparable values: names and user ids", () => {
    const fields = {
      summary: "Fix rounding",
      priority: { id: "2", name: "High" },
      duedate: "2026-10-20",
      assignee: { name: "ana.b", displayName: "Ana Bell" },
    };
    expect(issueFieldValues(fields, ["summary", "priority", "dueDate", "assignee"])).toEqual({
      summary: "Fix rounding",
      priority: "High",
      dueDate: "2026-10-20",
      assignee: "ana.b",
    });
    // Cloud users are their account id; empty values are null; only asked keys appear.
    expect(
      issueFieldValues(
        { assignee: { accountId: "acc-1", displayName: "A" }, priority: null, duedate: null },
        ["assignee", "priority", "dueDate"],
      ),
    ).toEqual({ assignee: "acc-1", priority: null, dueDate: null });
    expect(issueFieldValues(fields, ["dueDate"])).toEqual({ dueDate: "2026-10-20" });
  });

  test("status and open sprint", () => {
    expect(issueStatus({ status: { name: "Done", statusCategory: { key: "done" } } })).toEqual({
      name: "Done",
      category: "done",
    });
    expect(issueStatus({})).toBeNull();
    const sprint = (id: number, state: string) => ({ id, name: `S${id}`, state, boardId: 1 });
    expect(openSprint([sprint(1, "closed"), sprint(2, "active")])).toEqual({ id: 2, name: "S2" });
    expect(openSprint([sprint(1, "closed"), sprint(3, "future")])).toEqual({ id: 3, name: "S3" });
    // Only closed sprints: the issue is in the backlog.
    expect(openSprint([sprint(1, "closed")])).toBeNull();
    expect(openSprint(null)).toBeNull();
  });

  test("undoOf reads a stored result, and nothing from one made before undo was recorded", () => {
    expect(
      undoOf({ message: "x", undo: { kind: "add_comment", issueKey: "PAY-1", commentId: "9" } }),
    ).toEqual({ kind: "add_comment", issueKey: "PAY-1", commentId: "9" });
    expect(undoOf({ message: "x" })).toBeNull();
    expect(undoOf({ undo: { kind: "nope" } })).toBeNull();
    expect(undoOf(null)).toBeNull();
  });
});

const runLocal = <A>(
  f: (executor: Executor["Type"]) => Effect.Effect<A, unknown, Db>,
  payloadKind = "update_person",
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* query((d) =>
          d.insert(proposals).values({
            id: "p1",
            seq: 0,
            kind: payloadKind,
            payload: {},
            status: "approved",
            createdAt: "2020-01-01T00:00:00.000Z",
          }),
        );
        return yield* f(yield* Executor);
      }) as Effect.Effect<A, unknown, never>,
      Layer.provideMerge(ExecutorLive, syncedJiraLayer().layer),
    ),
  );

const opts = { proposalId: "p1", inboxItemId: null };

describe("undo recorded by local kinds", () => {
  test("update_person keeps the columns it changed, before and after", async () => {
    const r = await runLocal((executor) =>
      Effect.gen(function* () {
        const id = yield* createPerson({ displayName: "Dana", title: "Analyst" });
        const result = yield* executor.runProposal(
          ProposalPayloadSchema.parse({
            kind: "update_person",
            personId: id,
            changes: { title: "Finance lead", awayUntil: "2026-10-20" },
          }),
          opts,
        );
        return { id, result };
      }),
    );
    expect(r.result.undo).toEqual({
      kind: "update_person",
      personId: r.id,
      before: { title: "Analyst", awayUntil: null },
      after: { title: "Finance lead", awayUntil: "2026-10-20" },
    });
  });

  test("update_team keeps the columns it changed, the note included", async () => {
    const r = await runLocal(
      (executor) =>
        Effect.gen(function* () {
          const id = yield* createTeam({ name: "Finance" });
          const result = yield* executor.runProposal(
            ProposalPayloadSchema.parse({
              kind: "update_team",
              teamId: id,
              changes: { channel: "#finance" },
              noteAppend: "Owns the Q3 export",
            }),
            opts,
          );
          return { id, result };
        }),
      "update_team",
    );
    expect(r.result.undo).toMatchObject({
      kind: "update_team",
      teamId: r.id,
      before: { channel: null, notesMd: null },
      after: { channel: "#finance" },
    });
    const after = r.result.undo?.kind === "update_team" ? r.result.undo.after : {};
    expect(String(after.notesMd)).toContain("Owns the Q3 export");
  });

  test("update_dependency keeps the wait's state before and after and its timeline entry", async () => {
    const r = await runLocal(
      (executor) =>
        Effect.gen(function* () {
          const id = yield* createDependency({
            issueKey: "PAY-2",
            kind: "external",
            label: "Vendor quote",
            expectedAt: "2026-09-30",
          });
          const result = yield* executor.runProposal(
            ProposalPayloadSchema.parse({
              kind: "update_dependency",
              dependencyId: id,
              action: "resolve",
              summary: "Quote arrived",
              channel: "email",
            }),
            opts,
          );
          return { id, result };
        }),
      "update_dependency",
    );
    expect(r.result.undo).toMatchObject({
      kind: "update_dependency",
      dependencyId: r.id,
      before: { status: "open", expectedAt: "2026-09-30", resolvedAt: null },
      after: { status: "resolved", nextFollowupAt: null },
    });
    expect((r.result.undo as { followupId: string | null }).followupId).toBeString();
  });
});

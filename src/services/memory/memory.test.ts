import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { memories } from "@/db/schema";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { createPerson } from "@/services/directory/queries";
import {
  createMemory,
  deleteMemory,
  listMemories,
  setConfirmed,
  setWeight,
  updateMemory,
} from "./queries";

describe("memory queries", () => {
  test("create, label, reweigh, confirm, edit and delete", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const priya = yield* createPerson({ displayName: "Priya Shah" });
          const id = yield* createMemory({
            kind: "preference",
            content: "Copy Priya on escalations",
            subjectType: "person",
            subjectId: priya,
          });
          yield* query((d) =>
            d.insert(memories).values({
              id: "ex1",
              kind: "example",
              subjectType: "proposal_kind",
              subjectId: "create_issue",
              content: "Changed",
              exampleInput: "new task for refunds",
              exampleBefore: {
                kind: "create_issue",
                ref: "$new:1",
                projectKey: "PAY",
                issueType: "Task",
                summary: "Refunds",
              },
              exampleAfter: {
                kind: "create_issue",
                ref: "$new:1",
                projectKey: "PAY",
                issueType: "Story",
                summary: "Refunds",
              },
              source: "user",
              sourceInboxItemId: null,
              confirmed: true,
              createdAt: "2026-09-01T00:00:00Z",
            }),
          );
          const first = yield* listMemories;
          yield* setWeight(id, 2);
          yield* setConfirmed(id, false);
          yield* updateMemory(id, {
            kind: "rule",
            content: "Copy Priya on every escalation",
            subjectType: "person",
            subjectId: priya,
            weight: 2,
          });
          const edited = (yield* listMemories).find((m) => m.id === id);
          yield* deleteMemory(id);
          return { first, edited, after: yield* listMemories };
        }),
        DbTest,
      ),
    );
    expect(r.first.find((m) => m.kind === "preference")).toMatchObject({
      subjectLabel: "Priya Shah",
      source: "user",
      confirmed: true,
      weight: 1,
    });
    expect(r.first.find((m) => m.id === "ex1")?.example).toEqual({
      input: "new task for refunds",
      before: "Create Task in PAY: Refunds",
      after: "Create Story in PAY: Refunds (changed issueType: Task -> Story)",
    });
    expect(r.edited).toMatchObject({
      kind: "rule",
      content: "Copy Priya on every escalation",
      weight: 2,
      confirmed: false,
    });
    expect(r.after.map((m) => m.id)).toEqual(["ex1"]);
  });

  test("a subject needs both its type and id", () => {
    expect(() =>
      Effect.runSync(
        Effect.provide(createMemory({ kind: "rule", content: "x", subjectType: "person" }), DbTest),
      ),
    ).toThrow();
  });
});

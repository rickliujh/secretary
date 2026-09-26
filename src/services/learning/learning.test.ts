import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { memories, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { Intake } from "@/services/intake";
import { TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Learning } from ".";

const example = (id: string, input: string, summary: string) => ({
  id,
  kind: "example" as const,
  subjectType: "proposal_kind",
  subjectId: "create_issue",
  content: "Changed",
  exampleInput: input,
  exampleBefore: {
    kind: "create_issue",
    ref: "$new:1",
    projectKey: "PAY",
    issueType: "Task",
    summary,
  },
  exampleAfter: {
    kind: "create_issue",
    ref: "$new:1",
    projectKey: "PAY",
    issueType: "Story",
    summary,
  },
  source: "user" as const,
  confirmed: true,
  createdAt: `2026-09-2${id.at(-1)}T00:00:00Z`,
});

describe("Learning.consolidate", () => {
  test("turns repeated corrections into remember proposals in a new thread", async () => {
    const rule = "New work in PAY is a Story, not a Task.";
    const { layer, models } = intakeTestLayer({
      "std-m": [out({ rules: [{ memoryKind: "rule", content: rule, basedOn: ["1", "2"] }] })],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* query((d) =>
            d
              .insert(memories)
              .values([
                example("e1", "new task for refund totals", "Refunds"),
                example("e2", "we need work on the ledger export", "Export"),
              ]),
          );
          const res = yield* (yield* Learning).consolidate;
          const props = yield* query((d) =>
            d
              .select()
              .from(proposals)
              .where(eq(proposals.inboxItemId, res.inboxItemId ?? ""))
              .all(),
          );
          return { res, props };
        }),
        layer,
      ),
    );
    expect(r.res).toMatchObject({ rules: 1, corrections: 2 });
    expect(r.props).toHaveLength(1);
    expect(r.props[0]).toMatchObject({ kind: "remember", status: "pending" });
    expect(r.props[0]?.payload).toMatchObject({ memoryKind: "rule", content: rule });
    expect(r.props[0]?.rationale).toContain("Seen in 2 corrections");
    // Consolidation runs on the strong tier; the test layer has none, so it falls back to standard.
    expect(models.calls.map((c) => c.model)).toEqual(["std-m"]);
  });

  test("one correction is not enough", async () => {
    const { layer } = intakeTestLayer({});
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* query((d) => d.insert(memories).values(example("e1", "x", "Y")));
          return yield* Effect.either((yield* Learning).consolidate);
        }),
        layer,
      ),
    );
    expect(r._tag === "Left" && r.left._tag).toBe("LearningError");
  });
});

describe("Learning.replay", () => {
  test("re-runs decided items on the chosen tier and compares with what was approved", async () => {
    const e = { rationale: "r", evidence: "blocked", confidence: 0.9 };
    const transition = { kind: "transition_issue", target: "PAY-2", toStatus: "To Do", ...e };
    const comment = { kind: "add_comment", target: "PAY-2", body: "Blocked on INC0012345", ...e };
    const answer = (ps: unknown[]) => ({
      summary: "s",
      question: null,
      confidence: 0.9,
      proposals: ps,
    });
    const { layer, models } = intakeTestLayer({
      "std-m": [out(answer([transition, comment]))],
      // The replayed model repeats the comment the user rejected and misses the transition.
      "fast-m": [out(answer([comment]))],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const t = yield* (yield* Intake).triage({
            text: "PAY-2 is blocked on INC0012345, move it back to To Do.",
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          const ps = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, t.inboxItemId)).all(),
          );
          for (const p of ps)
            yield* query((d) =>
              d
                .update(proposals)
                .set({ status: p.kind === "transition_issue" ? "executed" : "rejected" })
                .where(eq(proposals.id, p.id)),
            );
          return yield* (yield* Learning).replay({ target: { tier: "fast" } });
        }),
        layer,
      ),
    );
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "fast-m"]);
    expect(r).toMatchObject({ items: 1, failed: 0, model: "fast-m" });
    expect(r.byKind).toEqual([
      { kind: "transition_issue", approved: 1, matched: 0, repeatedRejections: 0 },
      { kind: "add_comment", approved: 0, matched: 0, repeatedRejections: 1 },
    ]);
  });
});

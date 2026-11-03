/**
 * A work item's own thread (D61): its questions are answered through
 * `Intake.reply` like any other, and reach the item; the thread takes nothing
 * else, and has no input to read again.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxMessages, proposals, workEvents, workItems } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { Intake } from "@/services/intake";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { intakeTestLayer } from "@/test/intake-layer";
import { appendEvents } from "./events";
import { postQuestion, workThread } from "./questions";

describe("proposal events", () => {
  test("an approval and a failed approval are one event each, by the user, on the ticket", async () => {
    const { layer } = intakeTestLayer({});
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const now = nowIso();
          const row = (id: string, payload: Record<string, unknown>) => ({
            id,
            kind: String(payload.kind),
            payload,
            status: "pending" as const,
            createdAt: now,
          });
          yield* query((d) =>
            d.insert(proposals).values([
              row("p1", {
                kind: "remember",
                memoryKind: "fact",
                content: "PAY-2 ships with the Q3 release",
                subjectType: "issue",
                subjectId: "PAY-2",
              }),
              row("p2", {
                kind: "update_dependency",
                dependencyId: "nope",
                action: "resolve",
                issueKey: "PAY-2",
              }),
            ]),
          );
          const svc = yield* Proposals;
          yield* svc.approve("p1");
          yield* svc.approve("p2");
          return yield* query((d) => d.select().from(workEvents).orderBy(workEvents.id).all());
        }),
        Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, layer)),
      ),
    );
    expect(r.map((e) => [e.kind, e.actor, e.ref, e.issueKey])).toEqual([
      ["proposal_executed", "me", "p1", null],
      ["proposal_failed", "me", "p2", "PAY-2"],
    ]);
    expect(r[0]?.summary).toStartWith("Approved: ");
  });
});

describe("a work item's thread", () => {
  test("a choice answers through Intake.reply; other messages and a retriage are refused", async () => {
    const { layer } = intakeTestLayer({});
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const now = nowIso();
          yield* query((d) =>
            d.insert(workItems).values([
              { id: "w1", name: "Cert renewal", createdAt: now },
              { id: "w2", name: "Refunds", createdAt: now },
            ]),
          );
          const [ev] = yield* appendEvents([
            {
              kind: "jira_comment",
              actor: "jira:ana",
              summary: "Ana commented",
              data: { text: "done?" },
            },
          ]);
          const thread = yield* workThread("w1", "Cert renewal");
          const q = yield* postQuestion(thread, {
            question: "Which piece of work is this about?",
            choices: ["Cert renewal", "Refunds", "None of these"],
            work: { type: "attach", eventId: ev ?? "", itemIds: ["w1", "w2"] },
          });
          const intake = yield* Intake;
          const typed = yield* Effect.either(
            intake.reply({ inboxItemId: thread, instruction: "hello" }),
          );
          const answer = yield* intake.reply({
            inboxItemId: thread,
            parts: [{ type: "typed", text: "Refunds" }],
            answers: q,
          });
          const again = yield* Effect.either(intake.retriage(thread));
          const event = yield* query((d) =>
            d
              .select()
              .from(workEvents)
              .where(eq(workEvents.id, ev ?? ""))
              .get(),
          );
          const messages = yield* query((d) =>
            d.select().from(inboxMessages).where(eq(inboxMessages.inboxItemId, thread)).all(),
          );
          return { typed, answer, again, event, messages };
        }),
        layer,
      ),
    );
    expect(r.typed._tag).toBe("Left");
    if (r.typed._tag === "Left")
      expect(r.typed.left).toMatchObject({ _tag: "IntakeError", kind: "read_only" });
    expect(r.answer.questions).toBe(0);
    expect(r.event).toMatchObject({ workItemId: "w2", attachedBy: "answer", applied: false });
    expect(r.again._tag).toBe("Left");
    // The question turn, the answer, and the secretary's reply; the refused message left nothing.
    expect(r.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(r.messages[2]?.content).toEqual({ summary: 'Added to "Refunds".' });
  });
});

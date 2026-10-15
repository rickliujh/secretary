import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { memories, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { promptOf, readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Intake } from ".";

const e = { rationale: "because", evidence: "blocked on INC0012345", confidence: 0.9 };
const transition = { kind: "transition_issue", target: "PAY-2", toStatus: "To Do", ...e };
const dependency = {
  kind: "link_dependency",
  target: "PAY-2",
  dependencyKind: "incident",
  label: "Platform incident",
  ownerPersonId: null,
  ownerTeamId: null,
  externalRef: "INC0012345",
  expectedAt: null,
  ...e,
};
const answer = (proposals: unknown[], summary = "PAY-2 is blocked on INC0012345") => ({
  summary,
  question: null,
  confidence: 0.9,
  proposals,
});
const text = "PAY-2 is blocked on INC0012345 from Platform, can you move it back to To Do?";

describe("Intake threads (D22)", () => {
  test("pasted input with typed words: the words are a trusted instruction", async () => {
    const { layer, models } = intakeTestLayer({ "std-m": [out(answer([transition]))] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text,
            instruction: "only move it, no dependency",
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          return yield* readThread(res.inboxItemId);
        }),
        layer,
      ),
    );
    expect(r.messages.map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
    ]);
    expect(r.messages[0]?.content).toEqual({
      parts: [
        { type: "pasted", text },
        { type: "typed", text: "only move it, no dependency" },
      ],
      source: "teams",
    });
    expect(r.props[0]?.messageId).toBe(r.messages[1]?.id ?? "");
    const p = promptOf(models.calls, 0);
    expect(p).toContain("Instructions from the user in this conversation (trusted)");
    // The synced board's sprints, with positions and a projection (D23).
    expect(p).toContain("active, 2026-09-14 to 2026-09-28; Q3 2026 (Jul–Sep), sprint 6");
    expect(p).toContain("projected 1 after Payments 15");
    expect(p).toContain("1. only move it, no dependency");
    expect(p).toContain("<untrusted_input");
  });

  test("a typed reply replaces undecided proposals, keeps decided ones and records the change", async () => {
    const comment = { kind: "add_comment", target: "PAY-2", body: "Waiting on INC0012345.", ...e };
    const { layer, models } = intakeTestLayer({
      "std-m": [out(answer([transition, dependency])), out(answer([comment]))],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          const before = yield* readThread(first.inboxItemId);
          // The transition was approved and ran; only the dependency is undecided.
          yield* query((d) =>
            d
              .update(proposals)
              .set({ status: "executed" })
              .where(eq(proposals.id, before.props[0]?.id ?? "")),
          );
          const res = yield* intake.reply({
            inboxItemId: first.inboxItemId,
            instruction: "don't track the incident, comment on PAY-2 instead",
            today: TODAY,
          });
          const examples = yield* query((d) =>
            d.select().from(memories).where(eq(memories.kind, "example")).all(),
          );
          return { res, examples, ...(yield* readThread(first.inboxItemId)) };
        }),
        layer,
      ),
    );
    expect(r.res).toMatchObject({ items: 1, proposals: 1, questions: 0 });
    expect(r.props.map((p) => [p.kind, p.status])).toEqual([
      ["transition_issue", "executed"],
      ["link_dependency", "superseded"],
      ["add_comment", "pending"],
    ]);
    expect(r.props[2]?.messageId).toBe(r.messages[3]?.id ?? "");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const p = promptOf(models.calls, 1);
    expect(p).toContain("Approved: Move PAY-2 to To Do");
    expect(p).toContain("Your current proposals for this input, not yet decided");
    expect(p).toContain('\\"dependencyKind\\":\\"incident\\"');
    expect(p).toContain("1. don't track the incident, comment on PAY-2 instead");
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toMatchObject({ subjectType: "revision", source: "user" });
    expect(r.examples[0]?.content).toContain(
      "PAY-2 waits on Platform incident -> Comment on PAY-2",
    );
  });

  test("answering a question revises the item that asked and closes the question", async () => {
    const unsure = {
      summary: "Unclear",
      question: "Which ticket?",
      confidence: 0.2,
      proposals: [],
    };
    const { layer, models } = intakeTestLayer({
      "std-m": [out(unsure), out(answer([transition, dependency]))],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text: "It is blocked again.",
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          const question = (yield* readThread(first.inboxItemId)).props[0];
          const res = yield* intake.reply({
            inboxItemId: first.inboxItemId,
            instruction: "PAY-2, blocked on INC0012345; move it back to To Do",
            answers: question?.id ?? "",
            today: TODAY,
          });
          return { res, question, ...(yield* readThread(first.inboxItemId)) };
        }),
        layer,
      ),
    );
    expect(r.question?.kind).toBe("needs_clarification");
    expect(r.props.map((p) => [p.kind, p.status])).toEqual([
      ["needs_clarification", "executed"],
      ["transition_issue", "pending"],
      ["link_dependency", "pending"],
    ]);
    expect(r.props[0]?.result).toEqual({
      answer: "PAY-2, blocked on INC0012345; move it back to To Do",
    });
    expect(r.res.proposals).toBe(2);
    // No routing call: the answer goes to the item that asked.
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "std-m"]);
    expect(promptOf(models.calls, 1)).toContain("PAY-2, blocked on INC0012345");
  });

  test("pasted text in a reply adds items and leaves the earlier ones alone", async () => {
    const done = {
      kind: "transition_issue",
      target: "OPS-7",
      toStatus: "Done",
      ...e,
      evidence: "OPS-7 is done",
    };
    const { layer } = intakeTestLayer({
      "std-m": [out(answer([transition])), out(answer([done], "OPS-7 is done"))],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            text: "Tom: OPS-7 is done now.",
            today: TODAY,
          });
          return yield* readThread(first.inboxItemId);
        }),
        layer,
      ),
    );
    expect(r.props.map((p) => [p.kind, p.status])).toEqual([
      ["transition_issue", "pending"],
      ["transition_issue", "pending"],
    ]);
    expect(r.items.map((i) => i.idx).sort()).toEqual([0, 1]);
    expect(r.messages[2]?.content).toMatchObject({
      parts: [{ type: "pasted", text: "Tom: OPS-7 is done now." }],
    });
  });

  test("a paste in a typed thread is not typed, so its numbers need a points cue (D55)", async () => {
    const { layer } = intakeTestLayer({
      "std-m": [out(answer([transition])), out(answer([transition], "PAY-2"))],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            text: "Ana: make PAY-2 a 5",
            today: TODAY,
          });
          return yield* readThread(first.inboxItemId);
        }),
        layer,
      ),
    );
    expect(r.messages[2]?.content).toMatchObject({ source: "other" });
    const snapshots = r.items
      .sort((a, b) => a.idx - b.idx)
      .map((i) => (i.snapshot as { source: string }).source);
    expect(snapshots).toEqual(["typed", "other"]);
  });

  test("a revision keeps each item's source: a paste in a typed thread stays a paste (D55)", async () => {
    const points = {
      kind: "update_issue",
      target: "PAY-2",
      storyPoints: "8",
      pointsSource: "stated",
      ...e,
    };
    const { layer, models } = intakeTestLayer({
      "std-m": [
        out(answer([transition])),
        out(answer([transition], "PAY-2")),
        // Re-triage revises both items; the paste's un-cued 8 goes to repair.
        out(answer([transition])),
        out(answer([points], "PAY-2")),
        out(answer([transition], "PAY-2")),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            text: "Ana: PAY-2 needs 8 more days of work.",
            source: "teams",
            today: TODAY,
          });
          yield* intake.retriage(first.inboxItemId);
          return yield* readThread(first.inboxItemId);
        }),
        layer,
      ),
    );
    const revised = [...r.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(-2)
      .sort((a, b) => a.idx - b.idx)
      .map((i) => {
        const s = i.snapshot as { source: string; ownInput?: boolean };
        return [i.idx, s.source, s.ownInput];
      });
    expect(revised).toEqual([
      [0, "typed", true],
      [1, "teams", false],
    ]);
    expect(models.calls).toHaveLength(5);
    expect(promptOf(models.calls, 4)).toContain("storyPoints 8 is not given as story points");
    expect(r.props.filter((p) => p.status === "pending").map((p) => p.kind)).not.toContain(
      "update_issue",
    );
  });

  test("a later paste that says 'it' sees the thread's earlier items and their tickets", async () => {
    const cancel = { kind: "transition_issue", target: "PAY-2", toStatus: "Done", ...e };
    const why = {
      kind: "add_comment",
      target: "PAY-2",
      body: "Cancelled: the team is relocating.",
      ...e,
    };
    const { layer, models } = intakeTestLayer({
      "std-m": [out(answer([transition])), out(answer([cancel, why], "Cancel PAY-2"))],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          // No key in the new text: the ticket comes from earlier in the thread.
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            text: "Ana: the team is relocating, so please cancel that ticket.",
            today: TODAY,
          });
          return yield* readThread(first.inboxItemId);
        }),
        layer,
      ),
    );
    const prompt = promptOf(models.calls, 1);
    expect(prompt).toContain("## Earlier in this conversation (context only)");
    expect(prompt).toContain("PAY-2 is blocked on INC0012345");
    // PAY-2 is a candidate for the new item, so the model can act on it.
    const snapshot = r.items.find((i) => i.idx === 1)?.snapshot as {
      candidates: { key: string }[];
    };
    expect(snapshot.candidates.map((c) => c.key)).toContain("PAY-2");
    expect(r.props.filter((p) => p.status === "pending").map((p) => p.kind)).toEqual(
      expect.arrayContaining(["transition_issue", "add_comment"]),
    );
  });

  test("with several items, a reply goes only to the items the router picks", async () => {
    const long = [
      "Notes from the payments sync.",
      "PAY-2 is blocked on INC0012345 from Platform, move it back to To Do.",
      ...Array.from({ length: 9 }, (_, i) => `Discussion point ${i + 1} with no action.`),
      "OPS-7 is finished, Tom closed the firewall work.",
      "Nothing else.",
    ].join("\n");
    const quote1 = "PAY-2 is blocked on INC0012345 from Platform, move it back to To Do.";
    const quote2 = "OPS-7 is finished, Tom closed the firewall work.";
    const done = { kind: "transition_issue", target: "OPS-7", toStatus: "Done", ...e };
    const comment = { kind: "add_comment", target: "OPS-7", body: "Closed by Tom.", ...e };
    const { layer, models } = intakeTestLayer({
      "fast-m": [
        out({
          items: [
            { quote: quote1, topic: "PAY-2" },
            { quote: quote2, topic: "OPS-7" },
          ],
        }),
        out({ items: ["2"] }),
      ],
      "std-m": [
        out(answer([transition])),
        out(answer([done], "OPS-7 done")),
        out(answer([done, comment], "OPS-7 done")),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text: long,
            source: "meeting",
            senderPersonId: null,
            today: TODAY,
          });
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            instruction: "also leave a comment on the firewall one",
            today: TODAY,
          });
          return yield* readThread(first.inboxItemId);
        }),
        layer,
      ),
    );
    expect(models.calls.map((c) => c.model)).toEqual([
      "fast-m",
      "std-m",
      "std-m",
      "fast-m",
      "std-m",
    ]);
    expect(
      r.props.map((p) => [p.kind, (p.payload as { target: string }).target, p.status]),
    ).toEqual([
      ["transition_issue", "PAY-2", "pending"],
      ["transition_issue", "OPS-7", "superseded"],
      ["transition_issue", "OPS-7", "pending"],
      ["add_comment", "OPS-7", "pending"],
    ]);
  });

  test("a reply that fails keeps its message and retries on re-triage", async () => {
    const comment = { kind: "add_comment", target: "PAY-2", body: "Chasing Platform.", ...e };
    const { layer } = intakeTestLayer({
      "std-m": [
        out(answer([transition])),
        { status: 401, body: "invalid key" },
        out(answer([transition, comment])),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          const failed = yield* Effect.either(
            intake.reply({
              inboxItemId: first.inboxItemId,
              instruction: "and comment that we chase",
              today: TODAY,
            }),
          );
          const retried = yield* intake.retriage(first.inboxItemId);
          return { failed, retried, ...(yield* readThread(first.inboxItemId)) };
        }),
        layer,
      ),
    );
    expect(r.failed._tag).toBe("Left");
    expect(r.retried.proposals).toBe(2);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(r.props.map((p) => [p.kind, p.status])).toEqual([
      ["transition_issue", "superseded"],
      ["transition_issue", "pending"],
      ["add_comment", "pending"],
    ]);
  });
});

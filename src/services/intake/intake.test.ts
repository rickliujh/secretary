import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { inboxItems, intakeItems, llmCalls, proposals } from "@/db/schema";
import { CLASSIFY_PROMPT_VERSION } from "@/prompts/classify";
import { query } from "@/services/db";
import type { LlmError } from "@/services/llm";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Intake } from ".";

const e = { rationale: "because", evidence: "blocked on INC0012345", confidence: 0.9 };

const blockedAnswer = {
  summary: "PAY-2 is blocked on INC0012345",
  question: null,
  confidence: 0.9,
  proposals: [
    { kind: "transition_issue", target: "PAY-2", toStatus: "Blocked", ...e },
    {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "incident",
      label: "Platform incident",
      ownerPersonId: null,
      ownerTeamId: null,
      externalRef: "INC0012345",
      expectedAt: "2026-09-25",
      ...e,
    },
  ],
};

const text =
  "Hi Rick,\n\nPAY-2 is blocked on INC0012345 from Platform, can you move it to Blocked?\n\nThanks,\nAna";

const readBack = (inboxItemId: string) =>
  Effect.gen(function* () {
    const item = yield* query((d) =>
      d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
    );
    const props = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(eq(proposals.inboxItemId, inboxItemId))
        .orderBy(asc(proposals.seq))
        .all(),
    );
    const items = yield* query((d) =>
      d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, inboxItemId)).all(),
    );
    const calls = yield* query((d) => d.select().from(llmCalls).all());
    return { item, props, items, calls };
  });

// PAY-2 is already Blocked in the fixtures, so the canned answer moves it to another existing status.
const answer = {
  ...blockedAnswer,
  proposals: [{ ...blockedAnswer.proposals[0], toStatus: "To Do" }, blockedAnswer.proposals[1]],
};

describe("Intake.triage", () => {
  test("short input: one item, validated proposals persisted as pending, snapshot stored", async () => {
    const { layer, models } = intakeTestLayer({ "std-m": [out(answer)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: "2026-09-24",
          });
          return { res, ...(yield* readBack(res.inboxItemId)) };
        }),
        layer,
      ),
    );
    expect(r.res).toMatchObject({ items: 1, proposals: 2, questions: 0 });
    expect(r.item).toMatchObject({
      status: "triaged",
      summary: "PAY-2 is blocked on INC0012345",
      rawText: text,
    });
    expect(r.props.map((p) => [p.seq, p.kind, p.status])).toEqual([
      [0, "transition_issue", "pending"],
      [1, "link_dependency", "pending"],
    ]);
    expect(r.props[1]?.payload).toMatchObject({ target: "PAY-2", externalRef: "INC0012345" });
    expect(r.props[0]?.evidence).toBe("blocked on INC0012345");
    // Signature and greeting-only lines are stripped before the model sees the text.
    expect(r.items[0]?.quote).toBe(
      "Hi Rick,\n\nPAY-2 is blocked on INC0012345 from Platform, can you move it to Blocked?",
    );
    const snap = r.items[0]?.snapshot as { candidates: { key: string }[] } | undefined;
    expect(snap?.candidates[0]?.key).toBe("PAY-2");
    expect(r.items[0]).toMatchObject({
      tier: "standard",
      model: "std-m",
      promptVersion: CLASSIFY_PROMPT_VERSION,
    });
    // The pasted text reaches the model inside the untrusted wrapper.
    expect(JSON.stringify(models.calls[0]?.prompt)).toContain(
      '<untrusted_input source=\\"teams\\">',
    );
  });

  test("an out-of-candidate target is repaired, never stored", async () => {
    const bad = { ...answer, proposals: [{ ...answer.proposals[0], target: "PAY-99" }] };
    const { layer } = intakeTestLayer({ "std-m": [out(bad), out(answer)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text,
            source: "teams",
            senderPersonId: null,
          });
          return yield* readBack(res.inboxItemId);
        }),
        layer,
      ),
    );
    expect(r.props.map((p) => (p.payload as { target: string }).target)).toEqual([
      "PAY-2",
      "PAY-2",
    ]);
    expect(r.calls.map((c) => [c.task, c.validationOk])).toEqual([
      ["classify_item", false],
      ["repair_output", true],
    ]);
  });

  test("when repair fails too, the user gets a question instead of a guess", async () => {
    const bad = out({ ...answer, proposals: [{ ...answer.proposals[0], target: "PAY-99" }] });
    const { layer } = intakeTestLayer({ "std-m": [bad, bad] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text,
            source: "teams",
            senderPersonId: null,
          });
          return { res, ...(yield* readBack(res.inboxItemId)) };
        }),
        layer,
      ),
    );
    expect(r.res).toMatchObject({ proposals: 0, questions: 1 });
    expect(r.props.map((p) => p.kind)).toEqual(["needs_clarification"]);
    expect(r.items[0]?.error).toContain("failed validation");
  });

  test("the model's own question, or low confidence, adds a clarification", async () => {
    const unsure = { ...answer, confidence: 0.3, question: "Is this about PAY-2 or OPS-7?" };
    const { layer } = intakeTestLayer({ "std-m": [out(unsure)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text,
            source: "teams",
            senderPersonId: null,
          });
          return yield* readBack(res.inboxItemId);
        }),
        layer,
      ),
    );
    expect(r.props.map((p) => p.kind)).toEqual([
      "transition_issue",
      "link_dependency",
      "needs_clarification",
    ]);
    expect(r.props[2]?.payload).toEqual({
      kind: "needs_clarification",
      question: "Is this about PAY-2 or OPS-7?",
    });
    expect(r.items[0]?.lowConfidence).toBe(true);
  });

  test("low confidence alone keeps the proposals and does not ask", async () => {
    const run = (value: unknown) => {
      const { layer } = intakeTestLayer({ "std-m": [out(value)] });
      return Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* syncOnce;
            const res = yield* (yield* Intake).triage({
              text,
              source: "teams",
              senderPersonId: null,
            });
            return yield* readBack(res.inboxItemId);
          }),
          layer,
        ),
      );
    };
    const withProposals = await run({ ...answer, confidence: 0.3, question: null });
    expect(withProposals.props.map((p) => p.kind)).toEqual(["transition_issue", "link_dependency"]);
    expect(withProposals.items[0]?.lowConfidence).toBe(true);
  });

  test("long input is segmented; $new refs from different items are renumbered", async () => {
    const long = [
      "Meeting notes from the payments sync, 24 September.",
      "First: we need a new task in PAY to backfill refund totals for August, it should sit under the billing migration epic.",
      ...Array.from({ length: 6 }, (_, i) => `Discussion point ${i + 1} with no action.`),
      "Second: OPS needs a task to open the ledger firewall port; Tom will pick it up.",
      "Third: add a comment on the new PAY task that finance signed off.",
      "Nothing else.",
    ].join("\n");
    const quote1 =
      "First: we need a new task in PAY to backfill refund totals for August, it should sit under the billing migration epic.";
    const quote2 =
      "Second: OPS needs a task to open the ledger firewall port; Tom will pick it up.";
    const create = (projectKey: string, summary: string, epic: string | null) => ({
      kind: "create_issue",
      ref: "$new:1",
      projectKey,
      // The fixtures have no Task type in PAY; validation would (rightly) reject it.
      issueType: projectKey === "PAY" ? "Story" : "Task",
      summary,
      description: null,
      parent: null,
      epic,
      priority: null,
      assignee: null,
      dueDate: null,
      ...e,
    });
    const { layer, models } = intakeTestLayer({
      "fast-m": [
        out({
          items: [
            { quote: quote1, topic: "refunds" },
            { quote: quote2, topic: "firewall" },
          ],
        }),
      ],
      "std-m": [
        out({
          summary: "New refunds task",
          question: null,
          confidence: 0.9,
          proposals: [create("PAY", "Backfill August refund totals", "PAY-1")],
        }),
        out({
          summary: "New firewall task",
          question: null,
          confidence: 0.9,
          proposals: [
            create("OPS", "Open ledger firewall port", null),
            { kind: "add_comment", target: "$new:1", body: "Tom will pick this up.", ...e },
          ],
        }),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text: long,
            source: "meeting",
            senderPersonId: null,
          });
          return { res, ...(yield* readBack(res.inboxItemId)) };
        }),
        layer,
      ),
    );
    expect(models.calls.map((c) => c.model)).toEqual(["fast-m", "std-m", "std-m"]);
    expect(r.res.items).toBe(2);
    expect(r.props.map((p) => p.payload)).toMatchObject([
      { kind: "create_issue", ref: "$new:1", projectKey: "PAY", epic: "PAY-1" },
      { kind: "create_issue", ref: "$new:2", projectKey: "OPS" },
      { kind: "add_comment", target: "$new:2" },
    ]);
    expect(r.props.map((p) => p.intakeItemId)).toEqual(
      [r.items[0]?.id, r.items[1]?.id, r.items[1]?.id].map((x) => x ?? null) as never,
    );
  });

  test("a provider failure stops triage but keeps the raw text for a retry", async () => {
    const { layer } = intakeTestLayer({ "std-m": [{ status: 401, body: "bad key" }, out(answer)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const failed = yield* Effect.either(
            intake.triage({ text, source: "email", senderPersonId: null }),
          );
          const stored = yield* query((d) => d.select().from(inboxItems).all());
          const retried = yield* intake.retriage(stored[0]?.id ?? "");
          return { failed, stored, retried, after: yield* readBack(retried.inboxItemId) };
        }),
        layer,
      ),
    );
    expect(r.failed._tag === "Left" && (r.failed.left as LlmError).kind).toBe("auth");
    expect(r.stored[0]).toMatchObject({ status: "new", rawText: text });
    expect(JSON.stringify(r.stored[0]?.triage)).toContain("credentials");
    expect(r.retried.proposals).toBe(2);
    expect(r.after.item?.status).toBe("triaged");
  });
});

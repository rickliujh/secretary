/**
 * Taking a parked thread up (D62, Q1): a reply in it, or the last decision in
 * it, brings it back with an `unparked` event and no return day left.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, proposals, workEvents, workItems } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { Intake } from "@/services/intake";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { appendEvents } from "./events";

const comment = (body: string, evidence: string) =>
  out({
    summary: "Comment on PAY-2",
    question: null,
    confidence: 0.9,
    proposals: [
      {
        kind: "add_comment",
        target: "PAY-2",
        body,
        rationale: "Asked",
        evidence,
        confidence: 0.9,
      },
    ],
  });

/** Parks a thread as `parkThread` would, against item `w-cur`, its message on `w-other`. */
const parkByHand = (inboxItemId: string) =>
  Effect.gen(function* () {
    yield* query((d) =>
      d.insert(workItems).values([
        { id: "w-cur", name: "Cert", createdAt: nowIso() },
        { id: "w-other", name: "Rotate", createdAt: nowIso() },
      ]),
    );
    yield* appendEvents([
      {
        kind: "message",
        actor: "unknown",
        summary: "A message",
        data: { inboxItemId } as never,
        workItemId: "w-other",
        attachedBy: "code",
        applied: true,
      },
      {
        kind: "parked",
        actor: "me",
        ref: inboxItemId,
        summary: "Parked",
        data: {
          inboxItemId,
          currentItemId: "w-cur",
          reason: "on Cert",
          status: "triaged",
        } as never,
        workItemId: "w-other",
        attachedBy: "user",
        applied: true,
      },
    ]);
    yield* query((d) =>
      d
        .update(inboxItems)
        .set({ status: "parked", parkedReason: "on Cert", parkedUntil: "2099-01-01" })
        .where(eq(inboxItems.id, inboxItemId)),
    );
  });

const unparked = query((d) =>
  d.select().from(workEvents).where(eq(workEvents.kind, "unparked")).all(),
);
const threadRow = (id: string) =>
  query((d) => d.select().from(inboxItems).where(eq(inboxItems.id, id)).get());

describe("taking a parked thread up (D62)", () => {
  test("a reply un-parks it, saying so", async () => {
    const { layer } = intakeTestLayer({
      "std-m": [
        comment("Will do.", "please comment on PAY-2"),
        comment("Thanks, will do.", "please comment on PAY-2"),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const t = yield* intake.triage({
            text: "Sam: please comment on PAY-2",
            source: "teams",
            senderPersonId: null,
          });
          yield* parkByHand(t.inboxItemId);
          yield* intake.reply({ inboxItemId: t.inboxItemId, instruction: "Say thanks too" });
          return { row: yield* threadRow(t.inboxItemId), events: yield* unparked };
        }),
        layer,
      ),
    );
    expect(r.row).toMatchObject({ status: "triaged", parkedReason: "on Cert", parkedUntil: null });
    expect(r.events).toEqual([
      expect.objectContaining({
        workItemId: "w-other",
        actor: "me",
        data: expect.objectContaining({ why: "replied" }),
      }),
    ]);
  });

  test("the last decision un-parks it, then files it", async () => {
    const { layer } = intakeTestLayer({
      "std-m": [comment("Will do.", "please comment on PAY-2")],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const t = yield* intake.triage({
            text: "Sam: please comment on PAY-2",
            source: "teams",
            senderPersonId: null,
          });
          yield* parkByHand(t.inboxItemId);
          const [p] = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, t.inboxItemId)).all(),
          );
          yield* (yield* Proposals).reject(p?.id ?? "");
          return { row: yield* threadRow(t.inboxItemId), events: yield* unparked };
        }),
        Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, layer)),
      ),
    );
    expect(r.row).toMatchObject({ status: "filed", parkedUntil: null });
    expect(r.events.map((e) => (e.data as { why?: string }).why)).toEqual(["decided"]);
  });
});

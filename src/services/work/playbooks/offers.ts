/**
 * The "make that the rule?" offer (FR-19.7, Phase 26): reads the `step_left_out`
 * corrections and the user's earlier answers, and records an answer. Yes turns
 * the standing instruction off; both answers are `memories` preferences with
 * subject `playbook` (left out of classify's retrieval, like work item
 * corrections), so No is not offered again and Yes counts only later left-outs.
 */
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { memories } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { Settings, settingsOrDefault } from "@/services/settings";
import {
  INSTRUCTION_LABELS,
  type InstructionOffer,
  instructionOffer,
  type LeftOut,
  type OfferAnswer,
  offerSubject,
  STEP_INSTRUCTION,
  STEP_NOUNS,
} from "./instructions";

/** `memories.subject_type` of an answer to the offer. */
export const OFFER_SUBJECT_TYPE = "playbook";

const asRecord = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The offer a card of this playbook makes now, or null. */
export const offerFor = (playbook: string, stepKinds: readonly string[]) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const rows = yield* query((d) =>
      d
        .select({
          subjectType: memories.subjectType,
          subjectId: memories.subjectId,
          after: memories.exampleAfter,
          at: memories.createdAt,
        })
        .from(memories)
        .all(),
    );
    const leftOuts: LeftOut[] = [];
    const answers: OfferAnswer[] = [];
    for (const r of rows) {
      const after = asRecord(r.after);
      if (
        r.subjectType === "work_item" &&
        after.type === "step_left_out" &&
        typeof after.rule === "string" &&
        typeof after.kind === "string"
      )
        leftOuts.push({ rule: after.rule, kind: after.kind, at: r.at });
      if (
        r.subjectType === OFFER_SUBJECT_TYPE &&
        r.subjectId &&
        after.type === "instruction_offer" &&
        (after.answer === "yes" || after.answer === "no")
      )
        answers.push({ subject: r.subjectId, answer: after.answer, at: r.at });
    }
    return instructionOffer({
      playbook,
      stepKinds,
      leftOuts,
      answers,
      instructions: settings.secretary.instructions,
    });
  });

/** Yes turns the instruction off; either answer is remembered so the offer is not repeated. */
export const answerOffer = (
  offer: Pick<InstructionOffer, "playbook" | "stepKind">,
  answer: "yes" | "no",
) =>
  Effect.gen(function* () {
    const instruction = STEP_INSTRUCTION[offer.stepKind];
    if (!instruction) return;
    const noun = STEP_NOUNS[offer.stepKind] ?? "this step";
    const name = INSTRUCTION_LABELS[instruction].name;
    if (answer === "yes") {
      const settings = yield* Settings;
      yield* settings.update((s) => ({
        ...s,
        secretary: {
          ...s.secretary,
          instructions: { ...s.secretary.instructions, [instruction]: false },
        },
      }));
    }
    const subject = offerSubject(offer.playbook, offer.stepKind);
    // A later answer replaces an earlier one for the same playbook and step.
    yield* query((d) =>
      d
        .delete(memories)
        .where(and(eq(memories.subjectType, OFFER_SUBJECT_TYPE), eq(memories.subjectId, subject))),
    );
    yield* query((d) =>
      d.insert(memories).values({
        id: newId(),
        kind: "preference",
        subjectType: OFFER_SUBJECT_TYPE,
        subjectId: subject,
        content:
          answer === "yes"
            ? `Leave ${noun} out: "${name}" is off.`
            : `Keep offering ${noun}, and do not ask again.`,
        exampleAfter: { type: "instruction_offer", answer },
        source: "user",
        confirmed: true,
        createdAt: nowIso(),
      }),
    );
  });

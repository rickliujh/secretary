import { and, eq, inArray } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import { inboxItems, intakeItems, people, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import {
  buildClassifyPrompt,
  buildItemSchema,
  CLASSIFY_PROMPT_VERSION,
  type ItemOutput,
  type MappedProposal,
  mapItemOutput,
  validateItemOutput,
} from "@/prompts/classify";
import {
  buildSegmentPrompt,
  type SegmentOutput,
  SegmentOutputSchema,
  validateSegments,
} from "@/prompts/segment";
import { Db, query } from "@/services/db";
import { Llm } from "@/services/llm";
import { Retrieval } from "@/services/retrieval";
import {
  Intake,
  IntakeError,
  localDate,
  type Source,
  type TriageInput,
  type TriageResult,
} from ".";
import { mergeItemProposals } from "./merge";
import { cleanInput, extractReferences, needsSegmentation, type References } from "./preprocess";

const UNSURE_QUESTION =
  "I am not sure what should happen here. What would you like me to do with this?";

const make = Effect.gen(function* () {
  const db = yield* Db;
  const llm = yield* Llm;
  const retrieval = yield* Retrieval;
  const q = <A>(f: Parameters<typeof query<A>>[0]) => Effect.provideService(query(f), Db, db);

  /** Splits long input; falls back to one item if segmentation cannot be trusted. */
  const segment = (text: string, source: string) =>
    llm
      .object<SegmentOutput>("segment_input", {
        schema: SegmentOutputSchema,
        ...buildSegmentPrompt(text, source),
        validate: (out) => validateSegments(out, text),
      })
      .pipe(
        Effect.map((r) =>
          r.value.items.length > 0 ? r.value.items.map((i) => i.quote.trim()) : [text],
        ),
        // A bad split is not worth asking about: classify the whole text as one item.
        Effect.catchIf(
          (e) => e.kind === "schema",
          () => Effect.succeed([text]),
        ),
      );

  const mergeRefs = (a: References, b: References): References => ({
    issueKeys: [...new Set([...a.issueKeys, ...b.issueKeys])],
    tickets: [...new Set([...a.tickets, ...b.tickets])],
    emails: [...new Set([...a.emails, ...b.emails])],
    urls: [...new Set([...a.urls, ...b.urls])],
    contactIds: [...new Set([...a.contactIds, ...b.contactIds])],
  });

  const run = (inboxItemId: string, input: TriageInput & { rawText: string }) =>
    Effect.gen(function* () {
      const progress = input.onProgress ?? (() => undefined);
      const today = input.today ?? localDate();
      const cleaned = cleanInput(input.rawText) || input.rawText.trim();
      const contacts = yield* q((d) =>
        d
          .select({
            id: people.id,
            displayName: people.displayName,
            email: people.email,
            jiraUsername: people.jiraUsername,
          })
          .from(people)
          .all(),
      );
      const whole = extractReferences(cleaned, contacts);

      let quotes = [cleaned];
      if (needsSegmentation(cleaned)) {
        progress("Splitting into items");
        quotes = yield* segment(cleaned, input.source);
      }

      const perItem: MappedProposal[][] = [];
      const questions: { question: string; evidence: string }[] = [];
      const summaries: string[] = [];
      for (const [idx, quote] of quotes.entries()) {
        progress(quotes.length > 1 ? `Reading item ${idx + 1} of ${quotes.length}` : "Reading");
        const snapshot = yield* retrieval.snapshot({
          quote,
          source: input.source,
          senderPersonId: input.senderPersonId,
          references: mergeRefs(extractReferences(quote, contacts), { ...whole, contactIds: [] }),
          today,
          clarification: input.clarifies?.answer ?? null,
        });
        const schema = buildItemSchema(snapshot);
        const result = yield* Effect.either(
          llm.object<ItemOutput>("classify_item", {
            schema: schema as never,
            ...buildClassifyPrompt(snapshot),
            validate: (out) => validateItemOutput(out, snapshot),
            confidence: (out) => out.confidence,
          }),
        );
        const itemId = newId();
        if (Either.isLeft(result)) {
          const error = result.left;
          // Provider problems stop triage; the raw text is kept for a retry.
          if (error.kind !== "schema") return yield* error;
          yield* q((d) =>
            d.insert(intakeItems).values({
              id: itemId,
              inboxItemId,
              idx,
              quote,
              snapshot,
              promptVersion: CLASSIFY_PROMPT_VERSION,
              error: [error.message, ...(error.issues ?? [])].join("\n"),
            }),
          );
          perItem.push([]);
          questions.push({
            question: `I could not turn this into reliable actions: "${quote.slice(0, 200)}". What should happen?`,
            evidence: quote,
          });
          continue;
        }
        const { value, tier, model, escalated, lowConfidence } = result.right;
        summaries.push(value.summary);
        yield* q((d) =>
          d.insert(intakeItems).values({
            id: itemId,
            inboxItemId,
            idx,
            quote,
            summary: value.summary,
            snapshot,
            output: value,
            promptVersion: CLASSIFY_PROMPT_VERSION,
            tier,
            model,
            escalated,
            lowConfidence,
          }),
        );
        perItem.push(mapItemOutput(value));
        // Ask when the model asks, or when it is unsure and has nothing to propose.
        // Low-confidence proposals stay and show their confidence in review.
        if (value.question?.trim() || (lowConfidence && value.proposals.length === 0)) {
          questions.push({ question: value.question?.trim() || UNSURE_QUESTION, evidence: quote });
        }
      }

      const merged = mergeItemProposals(perItem);
      const now = nowIso();
      const itemIds = (yield* q((d) =>
        d
          .select({ id: intakeItems.id, idx: intakeItems.idx })
          .from(intakeItems)
          .where(eq(intakeItems.inboxItemId, inboxItemId))
          .all(),
      )).sort((a, b) => a.idx - b.idx);
      const rows = [
        ...merged.map((m, seq) => ({
          id: newId(),
          inboxItemId,
          intakeItemId: itemIds[m.itemIndex]?.id ?? null,
          seq,
          kind: m.payload.kind,
          payload: m.payload,
          rationale: m.rationale,
          evidence: m.evidence,
          confidence: m.confidence,
          status: "pending" as const,
          createdAt: now,
        })),
        ...questions.map((qn, i) => ({
          id: newId(),
          inboxItemId,
          intakeItemId: null,
          seq: merged.length + i,
          kind: "needs_clarification",
          payload: { kind: "needs_clarification", question: qn.question },
          rationale: null,
          evidence: qn.evidence,
          confidence: null,
          status: "pending" as const,
          createdAt: now,
        })),
      ];
      if (rows.length) yield* q((d) => d.insert(proposals).values(rows));

      yield* q((d) =>
        d
          .update(inboxItems)
          .set({
            status: "triaged",
            summary:
              summaries.join("; ") || (questions.length ? "Needs clarification" : "Nothing to do"),
            triage: {
              items: quotes.length,
              proposals: merged.length,
              questions: questions.length,
              at: now,
            },
          })
          .where(eq(inboxItems.id, inboxItemId)),
      );
      if (input.clarifies) {
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "executed",
              decidedAt: now,
              result: { answer: input.clarifies?.answer, followUp: inboxItemId },
            })
            .where(eq(proposals.id, input.clarifies?.proposalId ?? "")),
        );
      }
      logger.info(
        `Triage ${inboxItemId}: ${quotes.length} items, ${merged.length} proposals, ${questions.length} questions`,
      );
      return {
        inboxItemId,
        items: quotes.length,
        proposals: merged.length,
        questions: questions.length,
      } satisfies TriageResult;
    }).pipe(
      Effect.tapError((e) =>
        q((d) =>
          d
            .update(inboxItems)
            .set({ triage: { error: e.message, at: nowIso() } })
            .where(eq(inboxItems.id, inboxItemId)),
        ).pipe(Effect.ignore),
      ),
    );

  const triage = (input: TriageInput) =>
    Effect.gen(function* () {
      if (!input.text.trim())
        return yield* new IntakeError({ kind: "empty", message: "Paste or type something first." });
      const inboxItemId = newId();
      yield* q((d) =>
        d.insert(inboxItems).values({
          id: inboxItemId,
          source: input.source,
          senderPersonId: input.senderPersonId,
          rawText: input.text,
          receivedAt: nowIso(),
          status: "new",
        }),
      );
      return yield* run(inboxItemId, { ...input, rawText: input.text });
    });

  const retriage = (inboxItemId: string) =>
    Effect.gen(function* () {
      const item = yield* q((d) =>
        d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
      );
      if (!item)
        return yield* new IntakeError({
          kind: "not_found",
          message: "That inbox item no longer exists.",
        });
      // Decided proposals are history and stay; undecided ones are replaced.
      yield* q((d) =>
        d
          .delete(proposals)
          .where(
            and(eq(proposals.inboxItemId, inboxItemId), inArray(proposals.status, ["pending"])),
          ),
      );
      yield* q((d) => d.delete(intakeItems).where(eq(intakeItems.inboxItemId, inboxItemId)));
      return yield* run(inboxItemId, {
        text: item.rawText,
        rawText: item.rawText,
        source: item.source as Source,
        senderPersonId: item.senderPersonId,
      });
    });

  return Intake.of({ triage, retriage });
});

export const IntakeLive = Layer.effect(Intake, make);

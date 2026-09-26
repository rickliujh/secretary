import { and, desc, inArray, isNotNull, ne } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, inboxMessages, intakeItems, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import {
  buildClassifyPrompt,
  buildItemSchema,
  type ItemOutput,
  type ItemSnapshot,
  mapItemOutput,
  validateItemOutput,
} from "@/prompts/classify";
import {
  buildConsolidatePrompt,
  buildConsolidateSchema,
  type ConsolidateOutput,
  validateConsolidation,
} from "@/prompts/consolidate";
import { bindDb, Db } from "@/services/db";
import { replayAgreement } from "@/services/eval/score";
import { Llm } from "@/services/llm";
import { listMemories } from "@/services/memory/queries";
import { effectivePayload, type ProposalPayload } from "@/services/proposals/schema";
import { Learning, LearningError } from ".";

/** Corrections considered at once; the newest first. */
const MAX_CORRECTIONS = 40;
const DEFAULT_REPLAY = 30;

const make = Effect.gen(function* () {
  const llm = yield* Llm;
  const { q, withDb } = bindDb(yield* Db);

  const consolidate = Effect.gen(function* () {
    const all = yield* withDb(listMemories);
    const examples = all.filter((m) => m.kind === "example" && m.example).slice(0, MAX_CORRECTIONS);
    if (examples.length < 2)
      return yield* new LearningError({
        kind: "not_enough",
        message: "Rules need at least two corrections to learn from.",
      });
    const ctx = {
      examples: examples.map((m) => ({
        input: m.example?.input ?? "",
        proposed: m.example?.before ?? "",
        corrected: m.example?.after ?? null,
        about: m.subjectLabel,
      })),
      existing: all.filter((m) => m.kind !== "example").map((m) => m.content),
    };
    const { value } = yield* llm.object<ConsolidateOutput>("consolidate_rules", {
      schema: buildConsolidateSchema(examples.length) as never,
      ...buildConsolidatePrompt(ctx),
      validate: (out) => validateConsolidation(out, ctx),
    });
    if (value.rules.length === 0)
      return { inboxItemId: null, rules: 0, corrections: examples.length };

    // The suggestions arrive as a thread of `remember` proposals (D22, D26).
    const inboxItemId = newId();
    const messageId = newId();
    const now = nowIso();
    const summary = `${value.rules.length} rule${value.rules.length === 1 ? "" : "s"} suggested from your corrections`;
    yield* q((d) =>
      d.insert(inboxItems).values({
        id: inboxItemId,
        source: "other",
        senderPersonId: null,
        rawText: `Suggest rules from my last ${examples.length} corrections.`,
        receivedAt: now,
        status: "triaged",
        summary,
        triage: { items: 0, proposals: value.rules.length, questions: 0, at: now },
      }),
    );
    yield* q((d) =>
      d.insert(inboxMessages).values([
        {
          id: newId(),
          inboxItemId,
          seq: 0,
          role: "user",
          content: {
            parts: [
              { type: "typed", text: `Suggest rules from my last ${examples.length} corrections.` },
            ],
            source: "other",
            origin: "rules",
          },
          createdAt: now,
        },
        {
          id: messageId,
          inboxItemId,
          seq: 1,
          role: "assistant",
          content: { summary },
          createdAt: now,
        },
      ]),
    );
    yield* q((d) =>
      d.insert(proposals).values(
        value.rules.map((r, i) => {
          const basis = [...new Set(r.basedOn)].map((n) => ctx.examples[Number(n) - 1]);
          const payload: ProposalPayload = {
            kind: "remember",
            memoryKind: r.memoryKind,
            content: r.content.trim(),
            subjectType: null,
            subjectId: null,
          };
          return {
            id: newId(),
            inboxItemId,
            intakeItemId: null,
            messageId,
            seq: i,
            kind: "remember",
            payload,
            rationale:
              `Seen in ${basis.length} corrections: ${basis.map((b) => `${b?.proposed} -> ${b?.corrected ?? "rejected"}`).join("; ")}`.slice(
                0,
                1000,
              ),
            evidence: basis[0]?.input.slice(0, 300) ?? null,
            confidence: null,
            status: "pending" as const,
            createdAt: now,
          };
        }),
      ),
    );
    return { inboxItemId, rules: value.rules.length, corrections: examples.length };
  });

  const replay: Learning["Type"]["replay"] = ({ target, limit = DEFAULT_REPLAY, onProgress }) =>
    Effect.gen(function* () {
      // Items the user has fully decided: nothing pending, something approved or rejected.
      const rows = yield* q((d) =>
        d
          .select()
          .from(intakeItems)
          .where(isNotNull(intakeItems.output))
          .orderBy(desc(intakeItems.id))
          .limit(limit * 3)
          .all(),
      );
      const decided = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(
            and(
              inArray(
                proposals.intakeItemId,
                rows.map((r) => r.id),
              ),
              ne(proposals.kind, "needs_clarification"),
            ),
          )
          .all(),
      );
      const byItem = new Map<string, typeof decided>();
      for (const p of decided)
        byItem.set(p.intakeItemId ?? "", [...(byItem.get(p.intakeItemId ?? "") ?? []), p]);
      const items = rows
        // Snapshots older than the retention window are emptied (D34); they cannot be replayed.
        .filter((r) => !(r.snapshot as { pruned?: boolean }).pruned)
        .filter((r) => {
          const ps = byItem.get(r.id) ?? [];
          return (
            ps.length > 0 && ps.every((p) => p.status !== "pending" && p.status !== "superseded")
          );
        })
        .slice(0, limit);
      if (items.length === 0)
        return yield* new LearningError({
          kind: "not_enough",
          message: "There are no decided inbox items to replay yet.",
        });

      let failed = 0;
      let model = "";
      const scored = [];
      for (const [i, item] of items.entries()) {
        onProgress?.(i, items.length);
        const snapshot = item.snapshot as ItemSnapshot;
        const ps = byItem.get(item.id) ?? [];
        const r = yield* llm
          .object<ItemOutput>("classify_item", {
            schema: buildItemSchema(snapshot) as never,
            ...buildClassifyPrompt(snapshot),
            validate: (out) => validateItemOutput(out, snapshot),
            target,
          })
          .pipe(
            Effect.map((x) => {
              model = x.model;
              return mapItemOutput(x.value, item.quote).map((m) => m.payload);
            }),
            Effect.catchIf(
              (e) => e.kind === "schema",
              () => {
                failed++;
                return Effect.succeed([] as ProposalPayload[]);
              },
            ),
          );
        scored.push({
          done: ps
            .filter((p) => ["executed", "approved", "failed"].includes(p.status))
            .map(effectivePayload),
          rejected: ps.filter((p) => p.status === "rejected").map(effectivePayload),
          got: r,
        });
      }
      onProgress?.(items.length, items.length);
      return { items: items.length, failed, byKind: replayAgreement(scored), model };
    });

  return Learning.of({ consolidate, replay });
});

export const LearningLive = Layer.effect(Learning, make);

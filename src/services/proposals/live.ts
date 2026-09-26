import { and, asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, intakeItems, memories, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redact } from "@/lib/redact";
import { Db, query } from "@/services/db";
import { Executor } from "@/services/executor";
import {
  type DecisionResult,
  describePayload,
  effectivePayload,
  ProposalError,
  type ProposalPayload,
  ProposalPayloadSchema,
  Proposals,
  resolveRefs,
} from ".";

type Row = typeof proposals.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const db = yield* Db;
  const executor = yield* Executor;
  const q = <A>(f: Parameters<typeof query<A>>[0]) => Effect.provideService(query(f), Db, db);

  const load = (id: string) =>
    Effect.flatMap(
      q((d) => d.select().from(proposals).where(eq(proposals.id, id)).get()),
      (row) =>
        row
          ? Effect.succeed(row)
          : Effect.fail(
              new ProposalError({ kind: "not_found", message: "That proposal no longer exists." }),
            ),
    );

  /** Input excerpt for correction examples: the item quote, else the evidence. */
  const inputFor = (row: Row) =>
    Effect.gen(function* () {
      if (row.intakeItemId) {
        const item = yield* q((d) =>
          d
            .select({ quote: intakeItems.quote })
            .from(intakeItems)
            .where(eq(intakeItems.id, row.intakeItemId ?? ""))
            .get(),
        );
        if (item) return item.quote;
      }
      return row.evidence ?? "";
    });

  /** FR-7.2: a rejection or an edit becomes an example memory for later prompts. */
  const captureCorrection = (row: Row, after: ProposalPayload | null) =>
    Effect.gen(function* () {
      if (row.kind === "needs_clarification") return;
      const before = row.payload as ProposalPayload;
      const input = (yield* inputFor(row)).slice(0, 1000);
      yield* q((d) =>
        d.insert(memories).values({
          id: newId(),
          kind: "example",
          subjectType: "proposal_kind",
          subjectId: row.kind,
          content: after
            ? `Changed: ${describePayload(before)} -> ${describePayload(after)}`
            : `Rejected: ${describePayload(before)}`,
          exampleInput: input,
          exampleBefore: before,
          exampleAfter: after,
          source: "user",
          sourceInboxItemId: row.inboxItemId,
          confirmed: true,
          createdAt: nowIso(),
        }),
      );
    });

  /** Keys of issues already created by this inbox item's proposals, by `$new` ref. */
  const createdRefs = (inboxItemId: string | null) =>
    Effect.gen(function* () {
      const map = new Map<string, string>();
      if (!inboxItemId) return map;
      const rows = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(
            and(
              eq(proposals.inboxItemId, inboxItemId),
              eq(proposals.kind, "create_issue"),
              eq(proposals.status, "executed"),
            ),
          )
          .all(),
      );
      for (const r of rows) {
        const payload = effectivePayload(r);
        const key = (r.result as { issueKey?: string } | null)?.issueKey;
        if (payload.kind === "create_issue" && key) map.set(payload.ref, key);
      }
      return map;
    });

  /** Files the inbox item once nothing is left to decide. */
  const settleInbox = (inboxItemId: string | null) =>
    Effect.gen(function* () {
      if (!inboxItemId) return;
      const open = yield* q((d) =>
        d
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.status, "pending")))
          .all(),
      );
      if (open.length === 0)
        yield* q((d) =>
          d.update(inboxItems).set({ status: "filed" }).where(eq(inboxItems.id, inboxItemId)),
        );
    });

  const approve = (id: string, edited?: ProposalPayload) =>
    Effect.gen(function* () {
      const row = yield* load(id);
      if (row.status !== "pending" && row.status !== "failed") {
        return yield* new ProposalError({
          kind: "decided",
          message: `This proposal is already ${row.status}.`,
        });
      }
      if (row.kind === "needs_clarification") {
        return yield* new ProposalError({
          kind: "invalid",
          message: "Answer the question instead of approving it.",
        });
      }
      // A retry of a failed proposal keeps the edit it was first approved with.
      let payload = effectivePayload(row);
      if (edited) {
        const parsed = ProposalPayloadSchema.safeParse(edited);
        if (!parsed.success || parsed.data.kind !== row.kind) {
          return yield* new ProposalError({
            kind: "invalid",
            message: parsed.success
              ? "An edit cannot change the proposal kind."
              : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          });
        }
        // An edit already recorded on an earlier attempt is not recorded again.
        if (!same(parsed.data, row.payload) && !same(parsed.data, payload))
          yield* captureCorrection(row, parsed.data);
        payload = parsed.data;
      }
      yield* q((d) =>
        d
          .update(proposals)
          .set({
            status: "approved",
            decidedAt: nowIso(),
            editedPayload: same(payload, row.payload) ? null : payload,
          })
          .where(eq(proposals.id, id)),
      );

      const resolved = resolveRefs(payload, yield* createdRefs(row.inboxItemId));
      const outcome = yield* Effect.either(
        executor.runProposal(resolved, { proposalId: id, inboxItemId: row.inboxItemId }),
      );
      const result: DecisionResult =
        outcome._tag === "Right"
          ? { status: "executed", message: outcome.right.message, issueKey: outcome.right.issueKey }
          : { status: "failed", message: redact(outcome.left.message) };
      yield* q((d) =>
        d
          .update(proposals)
          .set({
            status: result.status,
            result: outcome._tag === "Right" ? outcome.right : { error: result.message },
          })
          .where(eq(proposals.id, id)),
      );
      if (result.status === "failed") logger.warn(`Proposal ${id} failed`, result.message);
      yield* settleInbox(row.inboxItemId);
      return result;
    });

  const reject = (id: string) =>
    Effect.gen(function* () {
      const row = yield* load(id);
      if (row.status !== "pending") {
        return yield* new ProposalError({
          kind: "decided",
          message: `This proposal is already ${row.status}.`,
        });
      }
      yield* captureCorrection(row, null);
      yield* q((d) =>
        d
          .update(proposals)
          .set({ status: "rejected", decidedAt: nowIso() })
          .where(eq(proposals.id, id)),
      );
      yield* settleInbox(row.inboxItemId);
    });

  const approveAll = (inboxItemId: string) =>
    Effect.gen(function* () {
      const pending = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.status, "pending")))
          .orderBy(asc(proposals.seq))
          .all(),
      );
      const results: DecisionResult[] = [];
      for (const row of pending) {
        if (row.kind === "needs_clarification") continue;
        results.push(yield* approve(row.id));
      }
      return results;
    });

  const dismiss = (inboxItemId: string) =>
    Effect.gen(function* () {
      yield* q((d) =>
        d
          .update(proposals)
          .set({ status: "rejected", decidedAt: nowIso(), result: { dismissed: true } })
          .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.status, "pending"))),
      );
      yield* q((d) =>
        d.update(inboxItems).set({ status: "dismissed" }).where(eq(inboxItems.id, inboxItemId)),
      );
    });

  return Proposals.of({ approve, reject, approveAll, dismiss });
});

export const ProposalsLive = Layer.effect(Proposals, make);

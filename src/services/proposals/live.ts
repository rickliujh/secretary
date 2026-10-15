import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  inboxItems,
  intakeItems,
  issueMeta,
  jiraIssues,
  memories,
  people,
  proposals,
  teams,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redact } from "@/lib/redact";
import { bindDb, Db } from "@/services/db";
import { Executor, undoOf } from "@/services/executor";
import { JiraClient } from "@/services/jira";
import { Sync } from "@/services/sync";
import { deletedKeys } from "@/services/sync/deleted";
import {
  type DecisionResult,
  describePayload,
  effectivePayload,
  issueRefs,
  ProposalError,
  type ProposalPayload,
  ProposalPayloadSchema,
  Proposals,
  parsePayload,
  type RevokedRecord,
  type RevokeErrorRecord,
  type RevokeResult,
  resolveRefs,
  withoutCodeFields,
} from ".";
import {
  cascadeOf,
  planRevoke,
  type RevokeFacts,
  type RevokePlan,
  type RevokeSubject,
  revokeBlock,
} from "./revoke";
import { revokeFacts } from "./revoke-facts";
import { runRevokeStep } from "./revoke-run";

type Row = typeof proposals.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const executor = yield* Executor;
  const jira = yield* JiraClient;
  const sync = yield* Sync;
  const db = yield* Db;
  const { q, withDb } = bindDb(db);

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

  /**
   * FR-7.2: a rejection or an edit becomes an example memory for later prompts.
   * Sprint moves come from the planner, not intake, so they teach intake nothing.
   */
  const captureCorrection = (row: Row, edited: ProposalPayload | null) =>
    Effect.gen(function* () {
      if (row.kind === "needs_clarification" || row.kind === "move_to_sprint") return;
      // The sprint switch is code's field, not something to learn from (D57).
      const before = withoutCodeFields(parsePayload(row.payload));
      const after = edited ? withoutCodeFields(edited) : null;
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

  /** An edit of a proposal, validated as a payload of the same kind. */
  const parseEdit = (row: Row, edited: ProposalPayload) =>
    Effect.gen(function* () {
      const parsed = ProposalPayloadSchema.safeParse(edited);
      if (parsed.success && parsed.data.kind === row.kind) return parsed.data;
      return yield* new ProposalError({
        kind: "invalid",
        message: parsed.success
          ? "An edit cannot change the proposal kind."
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    });

  const saveEdit = (id: string, edited: ProposalPayload) =>
    Effect.gen(function* () {
      const row = yield* load(id);
      if (row.status !== "pending") {
        return yield* new ProposalError({
          kind: "decided",
          message: `This proposal is already ${row.status}.`,
        });
      }
      const payload = yield* parseEdit(row, edited);
      yield* q((d) =>
        d
          .update(proposals)
          .set({ editedPayload: same(payload, parsePayload(row.payload)) ? null : payload })
          .where(and(eq(proposals.id, id), eq(proposals.status, "pending"))),
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
      // A retry of a failed proposal keeps the edit it was first approved with; a
      // pending one carries the edit saved from its row, if any (saveEdit).
      let payload = effectivePayload(row);
      // Compared after parsing, so defaults of newer fields do not count as an edit.
      const original = parsePayload(row.payload);
      // What earlier approvals already recorded: nothing for a pending proposal.
      const recorded = row.status === "failed" ? payload : original;
      if (edited) payload = yield* parseEdit(row, edited);
      const resolved = resolveRefs(payload, yield* createdRefs(row.inboxItemId));
      // A ticket a revoke deleted no longer exists, whichever thread proposed acting on it
      // (FR-14.6). A draft only mentions it, and a wait update changes Secretary's own row.
      const deleted = yield* withDb(deletedKeys);
      const acts = resolved.kind !== "draft_message" && resolved.kind !== "update_dependency";
      const gone = acts ? issueRefs(resolved, { only: "keys" }).filter((k) => deleted.has(k)) : [];
      if (gone.length)
        return yield* new ProposalError({
          kind: "invalid",
          message: `${gone.join(", ")} ${gone.length > 1 ? "were" : "was"} deleted when you revoked ${gone.length > 1 ? "them" : "it"}, so this can no longer run. Reject it instead.`,
        });
      // A change of the sprint switch alone is no correction (D57).
      const taught = withoutCodeFields(payload);
      if (!same(taught, withoutCodeFields(original)) && !same(taught, withoutCodeFields(recorded)))
        yield* captureCorrection(row, payload);
      yield* q((d) =>
        d
          .update(proposals)
          .set({
            status: "approved",
            decidedAt: nowIso(),
            editedPayload: same(payload, original) ? null : payload,
          })
          .where(eq(proposals.id, id)),
      );

      const outcome = yield* Effect.either(
        executor.runProposal(resolved, { proposalId: id, inboxItemId: row.inboxItemId }),
      );
      const result: DecisionResult =
        outcome._tag === "Right"
          ? {
              status: "executed",
              message: outcome.right.message,
              issueKey: outcome.right.issueKey,
              ...(outcome.right.warning ? { warning: outcome.right.warning } : {}),
            }
          : { status: "failed", message: redact(outcome.left.message) };
      // A failed run keeps the undo data it recorded before writing, so a retry
      // still knows what the first attempt replaced (D54).
      const kept = outcome._tag === "Left" ? undoOf((yield* load(id)).result) : null;
      yield* q((d) =>
        d
          .update(proposals)
          .set({
            status: result.status,
            result:
              outcome._tag === "Right"
                ? outcome.right
                : { error: result.message, ...(kept ? { undo: kept } : {}) },
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

  const track = (ids: readonly string[], edits: Readonly<Record<string, ProposalPayload>> = {}) =>
    Effect.gen(function* () {
      const results: DecisionResult[] = [];
      for (const id of ids) {
        const row = yield* load(id);
        if (row.status !== "pending" && row.status !== "failed") continue;
        const result = yield* approve(id, edits[id]);
        results.push(result);
        if (result.status === "failed" && row.kind === "create_issue") break;
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

  const toSubject = (row: Row): RevokeSubject => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: effectivePayload(row),
    result: row.result,
    seq: row.seq,
    decidedAt: row.decidedAt,
  });

  /** Fresh facts for one proposal, read from Jira and the database. */
  const factsOf = (s: RevokeSubject) =>
    revokeFacts(s).pipe(
      Effect.provideService(JiraClient, jira),
      Effect.provideService(Sync, sync),
      Effect.provideService(Db, db),
    );

  /** Contact and team names for the plan's texts. */
  const subjectNames = (subjects: readonly RevokeSubject[]) =>
    Effect.gen(function* () {
      const wanted = subjects.flatMap((s) =>
        s.payload.kind === "update_person"
          ? [s.payload.personId]
          : s.payload.kind === "update_team"
            ? [s.payload.teamId]
            : [],
      );
      const names = new Map<string, string>();
      if (!wanted.length) return names;
      for (const p of yield* q((d) =>
        d
          .select({ id: people.id, name: people.displayName })
          .from(people)
          .where(inArray(people.id, wanted))
          .all(),
      ))
        names.set(p.id, p.name);
      for (const t of yield* q((d) =>
        d
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inArray(teams.id, wanted))
          .all(),
      ))
        names.set(t.id, t.name);
      return names;
    });

  /** Display names of the Jira users the plan names (assignees put back), by user id. */
  const userNames = (subjects: readonly RevokeSubject[]) =>
    Effect.gen(function* () {
      const wanted = [
        ...new Set(
          subjects.flatMap((s) => {
            const u = undoOf(s.result);
            return u?.kind === "update_issue"
              ? [u.before.assignee, u.after.assignee].filter((x): x is string => !!x)
              : [];
          }),
        ),
      ];
      const names = new Map<string, string>();
      if (!wanted.length) return names;
      for (const i of yield* q((d) =>
        d
          .select({ id: jiraIssues.assignee, name: jiraIssues.assigneeDisplay })
          .from(jiraIssues)
          .where(inArray(jiraIssues.assignee, wanted))
          .all(),
      ))
        if (i.id && i.name) names.set(i.id, i.name);
      for (const i of yield* q((d) =>
        d
          .select({ id: jiraIssues.reporter, name: jiraIssues.reporterDisplay })
          .from(jiraIssues)
          .where(inArray(jiraIssues.reporter, wanted))
          .all(),
      ))
        if (i.id && i.name) names.set(i.id, i.name);
      // The user's own contacts name people as they know them.
      for (const p of yield* q((d) =>
        d
          .select({ id: people.jiraUsername, name: people.displayName })
          .from(people)
          .where(inArray(people.jiraUsername, wanted))
          .all(),
      ))
        if (p.id) names.set(p.id, p.name);
      // Names Jira showed when the approval ran come first.
      for (const s of subjects) {
        const u = undoOf(s.result);
        if (u?.kind === "update_issue")
          for (const [k, v] of Object.entries(u.names ?? {})) names.set(k, v);
      }
      return names;
    });

  /** The plan, the subjects it covers, and how it names Jira users. */
  const planOf = (id: string) =>
    Effect.gen(function* () {
      const row = yield* load(id);
      const subject = toSubject(row);
      const blocked = revokeBlock(subject);
      if (blocked)
        return {
          row,
          plan: { proposalId: id, entries: [], impossible: blocked } satisfies RevokePlan,
          subjects: [subject],
          user: (x: string) => x,
        };
      // Revoking a ticket first revokes what the thread did to it (FR-14.4).
      const siblings =
        subject.payload.kind === "create_issue" && row.inboxItemId
          ? (yield* q((d) =>
              d
                .select()
                .from(proposals)
                .where(eq(proposals.inboxItemId, row.inboxItemId ?? ""))
                .all(),
            )).map(toSubject)
          : [];
      const cascade = cascadeOf(subject, siblings);
      const facts = new Map<string, RevokeFacts>();
      for (const s of [...cascade, subject]) {
        if (revokeBlock(s)) continue;
        const f = yield* factsOf(s);
        if (f) facts.set(s.id, f);
      }
      const names = yield* subjectNames([...cascade, subject]);
      const users = yield* userNames([...cascade, subject]);
      const user = (x: string) => users.get(x) ?? null;
      return {
        row,
        plan: planRevoke(subject, cascade, facts, {
          subject: (x) => names.get(x) ?? null,
          user,
        }),
        subjects: [...cascade, subject],
        user: (x: string) => user(x) ?? x,
      };
    });

  const revokePlan = (id: string) => Effect.map(planOf(id), (p) => p.plan);

  const stepTexts = (plan: RevokePlan) =>
    plan.entries.flatMap((e) => (e.impossible ? [] : e.steps.map((s) => s.text)));

  /**
   * Proposals being revoked now, with what their cascade covers (FR-14.4): a
   * second revoke of any of them waits for the first to finish rather than
   * running the same steps twice.
   */
  const revoking = new Set<string>();
  const busy = () =>
    new ProposalError({
      kind: "busy",
      message: "This approval is already being revoked. Wait for it to finish.",
    });

  /**
   * After a create is revoked, the proposals of its thread still pending that
   * act on the ticket (or a sub-task revoked with it) can never run: they are
   * rejected without recording a correction, like a dismiss, and the thread is
   * filed once nothing is left to decide.
   */
  const rejectOrphans = (row: Row, subjects: readonly RevokeSubject[]) =>
    Effect.gen(function* () {
      if (!row.inboxItemId) return;
      const names = new Set(
        subjects.flatMap((s) =>
          s.payload.kind === "create_issue"
            ? [s.payload.ref, (s.result as { issueKey?: string } | null)?.issueKey].filter(
                (x): x is string => !!x,
              )
            : [],
        ),
      );
      if (!names.size) return;
      const pending = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(
            and(eq(proposals.inboxItemId, row.inboxItemId ?? ""), eq(proposals.status, "pending")),
          )
          .all(),
      );
      const orphans = pending
        .filter((p) => issueRefs(effectivePayload(p)).some((r) => names.has(r)))
        .map((p) => p.id);
      if (orphans.length)
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { dismissed: true, reason: "The ticket it acts on was revoked." },
            })
            .where(and(inArray(proposals.id, orphans), eq(proposals.status, "pending"))),
        );
      yield* settleInbox(row.inboxItemId);
    });

  const runRevoke = (id: string, confirmed: readonly string[] | undefined, held: Set<string>) =>
    Effect.gen(function* () {
      const { row, plan, subjects, user } = yield* planOf(id);
      if (plan.impossible)
        return yield* new ProposalError({ kind: "invalid", message: plan.impossible });
      // Hold every proposal the cascade covers, so their own Revoke waits too.
      const covered = plan.entries.map((e) => e.proposalId).filter((x) => !held.has(x));
      if (covered.some((x) => revoking.has(x))) return yield* busy();
      for (const x of covered) {
        revoking.add(x);
        held.add(x);
      }
      if (confirmed && !same(stepTexts(plan), [...confirmed]))
        return yield* new ProposalError({
          kind: "invalid",
          message:
            "What revoking does changed since you opened it. Check the steps again before revoking.",
        });
      const undone: string[] = [];
      const left: string[] = [];
      for (const entry of plan.entries) {
        if (entry.impossible) {
          left.push(`${entry.title} stays: ${entry.impossible}`);
          continue;
        }
        const warnings = [...entry.warnings];
        const did: string[] = [];
        let ticket = entry.ticket;
        for (const step of entry.steps) {
          const outcome = yield* Effect.either(
            runRevokeStep(step, entry.proposalId, user).pipe(
              Effect.provideService(JiraClient, jira),
              Effect.provideService(Executor, executor),
            ),
          );
          if (outcome._tag === "Left") {
            const message = redact(
              `${step.text} failed: ${outcome.left.message}${
                undone.length ? ` Undone so far: ${undone.join("; ")}.` : " Nothing was undone."
              } Revoke again to finish.`,
            );
            const current = yield* load(id);
            const revokeError: RevokeErrorRecord = { at: nowIso(), message, undone };
            yield* q((d) =>
              d
                .update(proposals)
                .set({ result: { ...((current.result as object | null) ?? {}), revokeError } })
                .where(eq(proposals.id, id)),
            );
            logger.warn(`Revoke of ${id} stopped`, message);
            return { status: "failed", message, undone } satisfies RevokeResult;
          }
          undone.push(...outcome.right.done);
          did.push(...outcome.right.done);
          if (outcome.right.warning) warnings.push(outcome.right.warning);
          if (outcome.right.ticket) ticket = outcome.right.ticket;
        }
        // A ticket gone from Jira before the revoke leaves the cache too (FR-14.6).
        if (ticket?.state === "deleted" && entry.steps.length === 0) {
          const key = ticket.key;
          yield* executor
            .reverse({ kind: "forget_issue", issueKey: key }, { proposalId: entry.proposalId })
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => logger.warn(`${key} stays in the cache`, e.message)),
              ),
            );
        }
        const record: RevokedRecord = {
          at: nowIso(),
          message: did.length
            ? did.join("; ")
            : (entry.notes[0] ?? warnings[0] ?? "Nothing was left to undo."),
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
          ...(ticket ? { ticket } : {}),
          ...(did.length ? {} : { unchanged: true as const }),
        };
        const current = yield* load(entry.proposalId);
        const { revokeError: _, ...kept } =
          (current.result as Record<string, unknown> | null) ?? {};
        yield* q((d) =>
          d
            .update(proposals)
            .set({ status: "revoked", result: { ...kept, revoked: record } })
            .where(eq(proposals.id, entry.proposalId)),
        );
        // Every later thread is told a closed ticket was revoked (FR-14.6); a deleted
        // one has its tombstone from the delete.
        if (ticket?.state === "closed") {
          const revokedAt = record.at;
          yield* q((d) =>
            d
              .insert(issueMeta)
              .values({ issueKey: ticket.key, revokedAt })
              .onConflictDoUpdate({ target: issueMeta.issueKey, set: { revokedAt } }),
          );
        }
        if (record.warning) left.push(record.warning);
      }
      // Only the creates that were revoked: one left as it is keeps its pending work.
      const gone = new Set(plan.entries.filter((e) => !e.impossible).map((e) => e.proposalId));
      yield* rejectOrphans(
        row,
        subjects.filter((x) => gone.has(x.id)),
      );
      const message = undone.length
        ? `Revoked: ${undone.join("; ")}`
        : "Revoked; nothing was left to undo";
      return {
        status: "revoked",
        message,
        undone,
        ...(left.length ? { warning: left.join(" ") } : {}),
      } satisfies RevokeResult;
    });

  const revoke = (id: string, confirmed?: readonly string[]) =>
    Effect.suspend(() => {
      // Checked and held in one synchronous step, so two presses cannot both pass.
      if (revoking.has(id)) return Effect.fail(busy());
      revoking.add(id);
      const held = new Set([id]);
      return runRevoke(id, confirmed, held).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const x of held) revoking.delete(x);
          }),
        ),
      );
    });

  return Proposals.of({
    approve,
    reject,
    approveAll,
    track,
    saveEdit,
    dismiss,
    revokePlan,
    revoke,
  });
});

export const ProposalsLive = Layer.effect(Proposals, make);

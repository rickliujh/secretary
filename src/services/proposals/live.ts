import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import {
  bundles,
  dependencies,
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
import { parseBlockers } from "@/services/blockers/logic";
import { blockInfo } from "@/services/dashboard/sections";
import { bindDb, Db } from "@/services/db";
import { Executor, ExecutorError, undoOf } from "@/services/executor";
import { JiraClient } from "@/services/jira";
import { parseIssueLinks } from "@/services/jira/schemas";
import { Sync } from "@/services/sync";
import { deletedKeys } from "@/services/sync/deleted";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { recordEvent } from "@/services/work/events";
import { takeUp } from "@/services/work/park";
import { correctionAfter, foundEdits, waitingFactsOf } from "@/services/work/playbooks/waiting";
import { bundleRecordOf, type SituationRecord, situationOf } from "@/services/work/schema";
import {
  createdIds,
  type DecisionResult,
  describePayload,
  directoryPlaceholders,
  directoryRefs,
  effectivePayload,
  issueRefs,
  ownRef,
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
import { threadRefs, waitingMessage } from "./thread-refs";

type Row = typeof proposals.$inferSelect;

/** Kinds whose revoke first revokes what the thread did with what they made. */
const CREATE_KINDS: readonly string[] = ["create_issue", "create_person", "create_team"];

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
  const captureCorrection = (
    row: Row,
    edited: ProposalPayload | null,
    /** The proposal as the model made it, when code changed it since (a playbook, Phase 26). */
    made?: ProposalPayload,
  ) =>
    Effect.gen(function* () {
      if (row.kind === "needs_clarification" || row.kind === "move_to_sprint") return;
      // The sprint switch is code's field, not something to learn from (D57).
      const before = withoutCodeFields(made ?? parsePayload(row.payload));
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

  /**
   * What this inbox item's executed creates made, by their ref: issue keys by
   * `$new` ref, contact and team ids by `$person` and `$team` ref (D60).
   */
  const createdRefs = (inboxItemId: string | null) =>
    Effect.gen(function* () {
      if (!inboxItemId) return { made: new Map<string, string>(), names: threadRefs([]) };
      const rows = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(
            and(
              eq(proposals.inboxItemId, inboxItemId),
              inArray(proposals.kind, ["create_issue", "create_person", "create_team"]),
            ),
          )
          .all(),
      );
      // A contact or team that existed by approval maps its ref to that one (FR-18.4).
      return { made: createdIds(rows), names: threadRefs(rows) };
    });

  /**
   * A proposal executed, failed or was revoked: a work event by the user (D61),
   * on the ticket it acted on (or created), with the tickets it names.
   */
  const proposalEvent = (
    row: Row,
    kind: "proposal_executed" | "proposal_failed" | "proposal_revoked",
    summary: string,
    createdKey?: string,
    payload: ProposalPayload = effectivePayload(row),
  ) => {
    const keys = [
      ...new Set([...(createdKey ? [createdKey] : []), ...issueRefs(payload, { only: "keys" })]),
    ];
    const made = (row.result as { issueKey?: string } | null)?.issueKey;
    return withDb(
      recordEvent({
        kind,
        actor: "me",
        issueKey: createdKey ?? made ?? keys[0] ?? null,
        ref: row.id,
        summary,
        data: {
          proposalKind: row.kind,
          keys,
          ...(row.inboxItemId ? { inboxItemId: row.inboxItemId } : {}),
          ...(payload.kind === "update_dependency" ? { dependencyId: payload.dependencyId } : {}),
        },
      }),
    );
  };

  /** Files the inbox item once nothing is left to decide. */
  const settleInbox = (inboxItemId: string | null) =>
    Effect.gen(function* () {
      if (!inboxItemId) return;
      const card = yield* q((d) =>
        d
          .select({ source: inboxItems.source })
          .from(inboxItems)
          .where(eq(inboxItems.id, inboxItemId))
          .get(),
      );
      // An outcome card stays open while a step failed, so it can be retried (Phase 25).
      const unsettled: ("pending" | "failed")[] =
        card?.source === "secretary" ? ["pending", "failed"] : ["pending"];
      const open = yield* q((d) =>
        d
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(eq(proposals.inboxItemId, inboxItemId), inArray(proposals.status, unsettled)))
          .all(),
      );
      if (open.length === 0) {
        // The last decision in a parked thread takes it up first (D62).
        yield* withDb(takeUp(inboxItemId, "decided"));
        yield* q((d) =>
          d.update(inboxItems).set({ status: "filed" }).where(eq(inboxItems.id, inboxItemId)),
        );
      }
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
      const refs = yield* createdRefs(row.inboxItemId);
      const resolved = resolveRefs(payload, refs.made);
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
      // A change of the sprint switch alone is no correction (D57). A step of an
      // outcome card or a playbook's chore is code's template, so an edit of it
      // teaches classify nothing; the proposal a playbook expanded is classify's
      // own and teaches as it was made (Phase 26, D46).
      const taught = withoutCodeFields(payload);
      const origin = isOrigin(row) ? yield* originOf(row) : null;
      if (
        (!row.bundleId || isOrigin(row)) &&
        !same(taught, withoutCodeFields(original)) &&
        !same(taught, withoutCodeFields(recorded))
      )
        yield* origin
          ? captureCorrection(
              row,
              correctionAfter({ stored: original, edited: payload, origin }),
              origin,
            )
          : captureCorrection(row, payload);
      // Moving back out of Blocked only while the ticket is still where the playbook put it.
      const stay = yield* stillBlocked(row, resolved);
      if (stay) {
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { leftOut: true, skipped: true, reason: stay },
            })
            .where(eq(proposals.id, id)),
        );
        yield* settleInbox(row.inboxItemId);
        return { status: "executed", message: stay } satisfies DecisionResult;
      }
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

      // A new contact or team it needs that is not added yet, named (D60).
      const waiting = directoryPlaceholders(resolved);
      const outcome = waiting.length
        ? Either.left(
            new ExecutorError({ kind: "invalid", message: waitingMessage(waiting, refs.names) }),
          )
        : yield* Effect.either(
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
      // A playbook's bookkeeping follows each step, however it was approved (a Retry too).
      if (result.status === "executed" && row.bundleId) yield* afterStep(row);
      yield* proposalEvent(
        { ...row, editedPayload: payload },
        result.status === "executed" ? "proposal_executed" : "proposal_failed",
        result.status === "executed"
          ? `Approved: ${describePayload(resolved)}`
          : `Failed: ${describePayload(resolved)}: ${result.message}`,
        result.issueKey,
        resolved,
      );
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
      // Rejecting the proposal a playbook expanded rejects the playbook: classify
      // learns from it as it made it, and its chores go without corrections (Phase 26).
      const origin = isOrigin(row) ? yield* originOf(row) : null;
      if (isOrigin(row)) yield* captureCorrection(row, null, origin ?? undefined);
      else if (row.bundleId) yield* leaveOut(row);
      else yield* captureCorrection(row, null);
      yield* q((d) =>
        d
          .update(proposals)
          .set({ status: "rejected", decidedAt: nowIso() })
          .where(eq(proposals.id, id)),
      );
      if (isOrigin(row))
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { dismissed: true, reason: "The proposal it belongs to was rejected." },
            })
            .where(
              and(
                eq(proposals.bundleId, row.bundleId ?? ""),
                inArray(proposals.status, ["pending", "failed"]),
              ),
            ),
        );
      // What needs a rejected create can never run: dropped as after a revoke (D60).
      if (CREATE_KINDS.includes(row.kind)) yield* rejectOrphans(row, [toSubject(row)], "rejected");
      yield* settleInbox(row.inboxItemId);
    });

  const approveAll = (inboxItemId: string) =>
    Effect.gen(function* () {
      const card = yield* q((d) =>
        d
          .select({ source: inboxItems.source })
          .from(inboxItems)
          .where(eq(inboxItems.id, inboxItemId))
          .get(),
      );
      // An outcome card runs as its bundle: in order, stopping at a failed required step.
      if (card?.source === "secretary") {
        const steps = yield* q((d) =>
          d
            .select({ id: proposals.id })
            .from(proposals)
            .where(and(eq(proposals.bundleId, inboxItemId), eq(proposals.status, "pending")))
            .all(),
        );
        return yield* approveBundle(
          inboxItemId,
          steps.map((x) => x.id),
        );
      }
      const pending = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.status, "pending")))
          .orderBy(asc(proposals.seq))
          .all(),
      );
      const results: DecisionResult[] = [];
      const bundled = new Set<string>();
      for (const row of pending) {
        if (row.kind === "needs_clarification") continue;
        // A playbook's bundle runs as one (Phase 26): in order, its choice as code made it.
        if (row.bundleId) {
          if (bundled.has(row.bundleId)) continue;
          bundled.add(row.bundleId);
          const ids = pending.filter((p) => p.bundleId === row.bundleId).map((p) => p.id);
          results.push(...(yield* approveBundle(row.bundleId, ids)));
          continue;
        }
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
      const card = yield* q((d) =>
        d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
      );
      // Dismissing an outcome card counts toward its rule going quiet on the item (D61).
      const situation = card?.source === "secretary" ? situationOf(card.triage) : null;
      // A card that already ran a step was taken up, not turned down: no quiet count.
      const ran = situation
        ? (yield* q((d) =>
            d
              .select({ id: proposals.id })
              .from(proposals)
              .where(
                and(
                  eq(proposals.bundleId, inboxItemId),
                  inArray(proposals.status, ["executed", "failed", "revoked"]),
                ),
              )
              .all(),
          )).length > 0
        : false;
      if (situation && card?.workItemId && card.status !== "dismissed")
        yield* withDb(
          recordEvent({
            kind: "outcome_dismissed",
            actor: "me",
            issueKey: situation.keys[0] ?? null,
            ref: inboxItemId,
            summary: `Dismissed: ${situation.title}`,
            data: {
              rule: situation.rule,
              inboxItemId,
              key: situation.key,
              ...(ran ? { ran: true } : {}),
            } as never,
            workItemId: card.workItemId,
            attachedBy: "user",
            applied: true,
          }),
        );
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

  /**
   * A step the user left out of an outcome card (Phase 25): a correction on the
   * work item, never a classify example, since code wrote the step.
   */
  const leaveOut = (row: Row) =>
    Effect.gen(function* () {
      const card = row.bundleId ? yield* loadBundle(row.bundleId) : null;
      const situation = card?.situation ?? null;
      const label = situation?.steps.find((x) => x.seq === row.seq)?.label ?? row.rationale ?? "";
      const payload = parsePayload(row.payload);
      yield* q((d) =>
        d.insert(memories).values({
          id: newId(),
          kind: "example",
          subjectType: "work_item",
          subjectId: card?.workItemId ?? null,
          content: `Left out of "${situation?.title ?? "an outcome"}": ${label || describePayload(payload)}`,
          exampleInput: situation?.why ?? null,
          exampleBefore: payload,
          exampleAfter: {
            type: "step_left_out",
            rule: row.bundleKind ?? situation?.rule ?? "",
            kind: row.kind,
          },
          source: "user",
          sourceInboxItemId: row.inboxItemId,
          confirmed: true,
          createdAt: nowIso(),
        }),
      );
    });

  const approveBundle = (
    bundleId: string,
    keep: readonly string[],
    edits: Readonly<Record<string, ProposalPayload>> = {},
    opts: { found?: string | null } = {},
  ) =>
    Effect.gen(function* () {
      const card = yield* loadBundle(bundleId);
      if (!card)
        return yield* new ProposalError({
          kind: "not_found",
          message: "That card no longer exists.",
        });
      if (card.status === "dismissed")
        return yield* new ProposalError({ kind: "decided", message: "This card was dismissed." });
      const situation = card.situation;
      const required = new Set(situation?.steps.filter((x) => x.required).map((x) => x.seq) ?? []);
      const steps = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(eq(proposals.bundleId, bundleId))
          .orderBy(asc(proposals.seq))
          .all(),
      );
      const open = steps.filter((x) => x.status === "pending" || x.status === "failed");
      // The found ticket (Phase 26): the user's pick, else the one code pre-selected.
      const choice = choiceEdits(situation, open, opts.found);
      const wanted = new Set(keep);
      const decidable = open.filter((x) => !choice.silent.has(x.id));
      // Leaving out a step the others hang on leaves them out too.
      // Pending or failed alike: a required step not kept takes its dependents with it.
      const requiredOut = decidable.some((x) => required.has(x.seq) && !wanted.has(x.id));
      const run = decidable.filter(
        (x) => wanted.has(x.id) && (!requiredOut || required.has(x.seq)),
      );
      const leftOut = decidable.filter((x) => !run.includes(x));
      // No ticket picked: the link to it is skipped, which is no correction.
      for (const x of open.filter((o) => choice.silent.has(o.id)))
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { leftOut: true, reason: "None of the found tickets was picked." },
            })
            .where(and(eq(proposals.id, x.id), inArray(proposals.status, ["pending", "failed"]))),
        );
      for (const x of leftOut) {
        yield* leaveOut(x);
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { leftOut: true, reason: "Left out when you approved the card." },
            })
            .where(and(eq(proposals.id, x.id), inArray(proposals.status, ["pending", "failed"]))),
        );
      }
      const results: DecisionResult[] = [];
      for (const x of run) {
        const result = yield* approve(x.id, edits[x.id] ?? choice.edits[x.id]);
        results.push(result);
        if (result.status === "failed" && required.has(x.seq)) break;
      }
      // A card with no steps (a reminder) is done once seen.
      if (card.outcome && steps.length === 0)
        yield* q((d) =>
          d.update(inboxItems).set({ status: "filed" }).where(eq(inboxItems.id, bundleId)),
        );
      else yield* settleInbox(card.inboxItemId);
      return results;
    });

  /**
   * What the found-ticket choice changes in a "waiting on someone" bundle
   * (Phase 26): edits by proposal id, and the link step to skip when nothing
   * is picked. `found` undefined keeps code's pre-selection.
   */
  const choiceEdits = (
    situation: SituationRecord | null,
    open: readonly Row[],
    found: string | null | undefined,
  ) => {
    const edits: Record<string, ProposalPayload> = {};
    const silent = new Set<string>();
    const facts = situation?.found ? waitingFactsOf(situation.facts) : null;
    if (!situation?.found || !facts || situation.rule !== "waiting_on_someone")
      return { edits, silent };
    const meta = new Map(situation.steps.map((x) => [x.seq, x]));
    const r = foundEdits({
      facts,
      found: situation.found,
      choice: found === undefined ? situation.found.picked : found,
      steps: open.map((x) => ({
        seq: x.seq,
        payload: effectivePayload(x),
        choice: !!meta.get(x.seq)?.choice,
      })),
    });
    for (const x of open) {
      const e = r.edits.get(x.seq);
      if (e) edits[x.id] = e;
      if (r.skip.includes(x.seq)) silent.add(x.id);
    }
    return { edits, silent };
  };

  /** The proposal a playbook bundle in a thread expanded: its id is the bundle's (Phase 26). */
  const isOrigin = (row: Row) => !!row.bundleId && row.bundleId === row.id;

  /** That proposal as the model made it, from the bundle record; null for older bundles. */
  const originOf = (row: Row) =>
    Effect.gen(function* () {
      const card = row.bundleId ? yield* loadBundle(row.bundleId) : null;
      const raw = card?.situation?.origin;
      if (!raw) return null;
      const parsed = ProposalPayloadSchema.safeParse(raw);
      return parsed.success && parsed.data.kind === row.kind ? parsed.data : null;
    });

  /**
   * Why a "wait resolved" move back out of Blocked should not run now: the
   * ticket left the status the playbook set (read fresh from Jira). Null to run.
   */
  const stillBlocked = (row: Row, payload: ProposalPayload) =>
    Effect.gen(function* () {
      if (row.bundleKind !== "wait_resolved" || payload.kind !== "transition_issue") return null;
      const card = row.bundleId ? yield* loadBundle(row.bundleId) : null;
      const set = (card?.situation?.facts as { blocked?: { to?: unknown } } | undefined)?.blocked
        ?.to;
      if (typeof set !== "string") return null;
      const now = yield* Effect.either(jira.getIssue(payload.target, { fields: ["status"] }));
      if (now._tag === "Left") return null;
      const name = (now.right.fields as { status?: { name?: unknown } }).status?.name;
      return typeof name === "string" && name.toLowerCase() !== set.toLowerCase()
        ? `${payload.target} is in ${name} now, not ${set}; left as it is.`
        : null;
    });

  /**
   * After a step of a playbook bundle ran (Phase 26), whether through the card,
   * Approve all or a Retry: a wait whose ticket the bundle moved to a
   * Blocked-like status remembers the status it left, so resolving it can move
   * it back; a resolved wait hands that memory to another wait still open on
   * the ticket, or wakes the ticket when nothing else holds it.
   */
  const afterStep = (step: Row) =>
    Effect.gen(function* () {
      const card = step.bundleId ? yield* loadBundle(step.bundleId) : null;
      const situation = card?.situation;
      if (!situation) return;
      const rows = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(eq(proposals.bundleId, step.bundleId ?? ""))
          .all(),
      );
      const executed = (kind: string) =>
        rows.find((r) => r.kind === kind && r.status === "executed");
      if (situation.rule === "waiting_on_someone") {
        if (step.kind !== "link_dependency" && step.kind !== "transition_issue") return;
        const link = executed("link_dependency");
        const depId =
          (link?.result as { dependencyId?: string } | null)?.dependencyId ??
          waitingFactsOf(situation.facts)?.dependencyId ??
          null;
        const undo = undoOf(executed("transition_issue")?.result);
        if (depId && undo?.kind === "transition_issue") {
          const dep = yield* q((d) =>
            d.select().from(dependencies).where(eq(dependencies.id, depId)).get(),
          );
          if (dep)
            yield* q((d) =>
              d
                .update(dependencies)
                .set({
                  data: {
                    ...(dep.data ?? {}),
                    blocked: { issueKey: undo.issueKey, from: undo.fromStatus, to: undo.toStatus },
                  },
                })
                .where(eq(dependencies.id, depId)),
            );
        }
      }
      if (situation.rule === "wait_resolved") {
        const resolve = rows.find((r) => r.kind === "update_dependency");
        const payload = resolve ? effectivePayload(resolve) : null;
        const depId = payload?.kind === "update_dependency" ? payload.dependencyId : null;
        if (!depId) return;
        const dep = yield* q((d) =>
          d.select().from(dependencies).where(eq(dependencies.id, depId)).get(),
        );
        if (!dep) return;
        const clear = () =>
          q((d) =>
            d
              .update(dependencies)
              .set({ data: { ...dep.data, blocked: undefined } })
              .where(eq(dependencies.id, depId)),
          );
        // Moved back out of Blocked: nothing left to undo later.
        if (step.kind === "transition_issue") {
          if (dep.data?.blocked) yield* clear();
          return;
        }
        if (step.kind !== "update_dependency") return;
        // Another wait still holds the ticket in Blocked: it takes over the memory.
        const blocked = dep.data?.blocked;
        if (blocked) {
          const other = (yield* q((d) =>
            d
              .select()
              .from(dependencies)
              .where(
                and(eq(dependencies.issueKey, dep.issueKey), ne(dependencies.status, "resolved")),
              )
              .all(),
          )).find((w) => w.id !== dep.id);
          if (other) {
            yield* q((d) =>
              d
                .update(dependencies)
                .set({ data: { ...(other.data ?? {}), blocked } })
                .where(eq(dependencies.id, other.id)),
            );
            yield* clear();
          }
        }
        yield* wakeAfterWait(dep);
      }
    });

  /**
   * A resolved wait wakes its ticket (Today's woken row, D45) when nothing else
   * holds it: no other open wait on it, no open blocker, and it is not done.
   */
  const wakeAfterWait = (dep: typeof dependencies.$inferSelect) =>
    Effect.gen(function* () {
      const others = yield* q((d) =>
        d
          .select({ id: dependencies.id })
          .from(dependencies)
          .where(and(eq(dependencies.issueKey, dep.issueKey), ne(dependencies.status, "resolved")))
          .all(),
      );
      if (others.length > 0) return;
      const meta = yield* q((d) =>
        d.select().from(issueMeta).where(eq(issueMeta.issueKey, dep.issueKey)).get(),
      );
      if (meta?.openBlockers?.length) return;
      const issue = yield* q((d) =>
        d
          .select({ category: jiraIssues.statusCategory, raw: jiraIssues.raw })
          .from(jiraIssues)
          .where(eq(jiraIssues.key, dep.issueKey))
          .get(),
      );
      if (!issue || issue.category === "done") return;
      // A Jira blocker still open holds it too (D45): the fresh blocker states first.
      const fresh = parseBlockers(yield* withDb(getState(SYNC_KEYS.blockers)));
      const links = parseIssueLinks((issue.raw as { issuelinks?: unknown } | null)?.issuelinks);
      if (blockInfo(links, fresh).blockedBy.length > 0) return;
      const owner = dep.ownerPersonId
        ? (yield* q((d) =>
            d
              .select({ name: people.displayName })
              .from(people)
              .where(eq(people.id, dep.ownerPersonId ?? ""))
              .get(),
          ))?.name
        : dep.ownerTeamId
          ? (yield* q((d) =>
              d
                .select({ name: teams.name })
                .from(teams)
                .where(eq(teams.id, dep.ownerTeamId ?? ""))
                .get(),
            ))?.name
          : null;
      const at = nowIso();
      const by = `wait:${owner ?? "They"} delivered ${dep.label}`.slice(0, 300);
      yield* q((d) =>
        d
          .insert(issueMeta)
          .values({ issueKey: dep.issueKey, unblockedAt: at, unblockedBy: by })
          .onConflictDoUpdate({
            target: issueMeta.issueKey,
            set: { unblockedAt: at, unblockedBy: by, unblockNotifiedAt: null },
          }),
      );
    });

  /** A bundle's card: an outcome card (its own inbox item) or a playbook bundle in a thread. */
  const loadBundle = (bundleId: string) =>
    Effect.gen(function* () {
      const card = yield* q((d) =>
        d.select().from(inboxItems).where(eq(inboxItems.id, bundleId)).get(),
      );
      if (card)
        return {
          outcome: true,
          situation: situationOf(card.triage),
          inboxItemId: card.id,
          workItemId: card.workItemId,
          status: card.status,
        };
      const stored = yield* q((d) =>
        d.select().from(bundles).where(eq(bundles.id, bundleId)).get(),
      );
      if (!stored) return null;
      const thread = yield* q((d) =>
        d
          .select({ status: inboxItems.status })
          .from(inboxItems)
          .where(eq(inboxItems.id, stored.inboxItemId))
          .get(),
      );
      return {
        outcome: false,
        situation: bundleRecordOf(stored.record),
        inboxItemId: stored.inboxItemId,
        workItemId: null as string | null,
        status: thread?.status ?? "triaged",
      };
    });

  const fileBundle = (bundleId: string) =>
    q((d) =>
      d
        .update(inboxItems)
        .set({ status: "filed" })
        .where(
          and(
            eq(inboxItems.id, bundleId),
            eq(inboxItems.source, "secretary"),
            eq(inboxItems.status, "triaged"),
          ),
        ),
    ).pipe(Effect.asVoid);

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
      // Revoking a ticket, contact or team first revokes what the thread did with it
      // (FR-14.4, FR-18.6).
      const siblings =
        CREATE_KINDS.includes(subject.payload.kind) && row.inboxItemId
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
   * act on the ticket (or a sub-task revoked with it), or use the contact or team
   * (D60), can never run: they are rejected without recording a correction, like
   * a dismiss, and the thread is filed once nothing is left to decide.
   */
  const rejectOrphans = (
    row: Row,
    subjects: readonly RevokeSubject[],
    how: "revoked" | "rejected" = "revoked",
  ) =>
    Effect.gen(function* () {
      if (!row.inboxItemId) return;
      const names = new Set(
        subjects.flatMap((s) => {
          const res = (s.result ?? {}) as { issueKey?: string; personId?: string; teamId?: string };
          const made =
            s.payload.kind === "create_issue"
              ? res.issueKey
              : s.payload.kind === "create_person"
                ? res.personId
                : s.payload.kind === "create_team"
                  ? res.teamId
                  : undefined;
          return CREATE_KINDS.includes(s.payload.kind) && "ref" in s.payload
            ? [s.payload.ref, made].filter((x): x is string => !!x)
            : [];
        }),
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
      const uses = (p: Row, refs: (x: ProposalPayload) => string[]) =>
        refs(effectivePayload(p)).some((r) => names.has(r));
      // What hangs on an orphaned create (a contact in a rejected team) goes too.
      const orphans: Row[] = [];
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of pending) {
          if (orphans.includes(p) || !(uses(p, issueRefs) || uses(p, directoryRefs))) continue;
          orphans.push(p);
          const own = ownRef(effectivePayload(p));
          if (own) names.add(own);
          grew = true;
        }
      }
      const reason = (p: Row) =>
        uses(p, issueRefs)
          ? `The ticket it acts on was ${how}.`
          : `The contact or team it needs was ${how}.`;
      for (const p of orphans)
        yield* q((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { dismissed: true, reason: reason(p) },
            })
            .where(and(eq(proposals.id, p.id), eq(proposals.status, "pending"))),
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
        yield* proposalEvent(current, "proposal_revoked", `Revoked: ${record.message}`);
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
    approveBundle,
    fileBundle,
    saveEdit,
    dismiss,
    revokePlan,
    revoke,
  });
});

export const ProposalsLive = Layer.effect(Proposals, make);

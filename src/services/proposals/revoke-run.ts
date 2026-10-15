/**
 * Runs one planned revoke step (D54 (3)) through `Executor.reverse`, resolving
 * what depends on Jira as it is when the step runs rather than when it was
 * planned: a delete checks the issue's sub-tasks again, and a delete Jira refuses
 * closes the issue instead in the same run; an assign Jira refuses is skipped
 * with a warning.
 */
import { Effect, Option } from "effect";
import { Executor, ExecutorError, issueStatus, type ReverseOp } from "@/services/executor";
import { JiraClient, type JiraError } from "@/services/jira";
import { isRevokeStatus, revokeTransition } from "@/services/jira/cancel";
import { createRevokeText, REVOKE_COMMENT, type RevokedTicket, type RevokeStep } from "./revoke";
import { hasRevokeComment } from "./revoke-facts";

/**
 * What a step did: the record of what was undone (none when skipped), a
 * warning, and for a create's delete what became of the ticket.
 */
export type StepOutcome = { done: string[]; warning?: string; ticket?: RevokedTicket };

/** Jira refusing a write it understood: no permission, or a value it will not take. */
const refused = (e: { _tag: string; status?: number }): e is JiraError =>
  e._tag === "JiraError" && (e.status === 400 || e.status === 403);

const errorText = (e: JiraError) => e.message.replace(/\.$/, "");

/**
 * Closes a revoked ticket that could not be deleted: the revoke comment (unless
 * it is there) and a move to the cancel status available now (unless it is
 * already done or cancelled). Fails when there is no such move.
 */
const closeInstead = (key: string, why: string, proposalId: string) =>
  Effect.gen(function* () {
    const executor = yield* Executor;
    const jira = yield* JiraClient;
    const done: string[] = [];
    if (!(yield* hasRevokeComment(key))) {
      yield* executor.reverse(
        {
          kind: "jira",
          action: { kind: "add_comment", issueKey: key, bodyMarkdown: REVOKE_COMMENT },
        },
        { proposalId },
      );
      done.push(`Commented on ${key}`);
    }
    const status = issueStatus((yield* jira.getIssue(key, { fields: ["status"] })).fields);
    let ticket: RevokedTicket = {
      key,
      state: "closed",
      status: status?.name ?? null,
      moved: false,
    };
    if (!status || (status.category !== "done" && !isRevokeStatus(status.name))) {
      const available = yield* jira.getTransitions(key);
      const t = revokeTransition(available);
      if (!t)
        return yield* new ExecutorError({
          kind: "invalid",
          message: `${key} could not be deleted (${why}) and has no transition to a cancelled or done status (available: ${available.map((x) => x.to.name).join(", ") || "none"}).`,
        });
      yield* executor.reverse(
        { kind: "transition_to", issueKey: key, status: t.to.name },
        { proposalId },
      );
      done.push(createRevokeText.moved(key, t.to.name));
      ticket = { key, state: "closed", status: t.to.name, moved: true };
    }
    return {
      done,
      warning: `${key} could not be deleted (${why}), so it was closed instead.`,
      ticket,
    } satisfies StepOutcome;
  });

/** The issue's sub-task keys now; none when the issue is gone. */
const subtasksNow = (key: string) =>
  Effect.gen(function* () {
    const jira = yield* JiraClient;
    const raw = yield* jira.getIssue(key, { fields: ["subtasks"] }).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (e) => e.status === 404,
        () => Effect.succeed(Option.none()),
      ),
    );
    if (Option.isNone(raw)) return null;
    const subs = raw.value.fields.subtasks;
    return Array.isArray(subs) ? subs.length : 0;
  });

/** Runs one step of a confirmed revoke; `user` names a Jira user for the warning. */
export const runRevokeStep = (step: RevokeStep, proposalId: string, user: (id: string) => string) =>
  Effect.gen(function* () {
    const executor = yield* Executor;
    const op: ReverseOp = step.op;
    if (op.kind === "jira" && op.action.kind === "delete_issue") {
      const key = op.action.issueKey;
      const gone = { done: [step.done], ticket: { key, state: "deleted" } } satisfies StepOutcome;
      // Already gone from Jira (deleted elsewhere, or a delete whose answer was
      // lost): only the cache still holds it.
      const forget = executor.reverse({ kind: "forget_issue", issueKey: key }, { proposalId });
      const subtasks = yield* subtasksNow(key);
      if (subtasks === null) return yield* Effect.as(forget, gone);
      if (subtasks > 0) return yield* closeInstead(key, "it still has sub-tasks", proposalId);
      const deleted = yield* Effect.either(executor.reverse(op, { proposalId }));
      if (deleted._tag === "Right") return gone;
      if (deleted.left._tag === "JiraError" && deleted.left.status === 404)
        return yield* Effect.as(forget, gone);
      if (refused(deleted.left))
        return yield* closeInstead(key, `Jira refused: ${errorText(deleted.left)}`, proposalId);
      return yield* Effect.fail(deleted.left);
    }
    if (op.kind === "jira" && op.action.kind === "assign") {
      const { issueKey, username } = op.action;
      const assigned = yield* Effect.either(executor.reverse(op, { proposalId }));
      if (assigned._tag === "Right") return { done: [step.done] } satisfies StepOutcome;
      if (refused(assigned.left))
        return {
          done: [],
          warning: `Jira refused to ${username ? `assign ${issueKey} back to ${user(username)}` : `unassign ${issueKey}`} (${errorText(assigned.left)}), so its assignee stays as it is.`,
        } satisfies StepOutcome;
      return yield* Effect.fail(assigned.left);
    }
    const r = yield* executor.reverse(op, { proposalId });
    return {
      done: [step.done],
      ...(r.warning ? { warning: r.warning } : {}),
    } satisfies StepOutcome;
  }).pipe(Effect.map((x): StepOutcome => x));

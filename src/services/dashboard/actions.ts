/**
 * Today's row actions (D49). Jira writes are the user's own and go through the
 * Executor as the ticket view's do; Jira is only read here. Local state (snooze,
 * the sweep's weekly mark) is written directly.
 */
import { Effect } from "effect";
import { logFollowup, setDates, setStatus } from "@/services/dependencies/queries";
import { Executor, ExecutorError } from "@/services/executor";
import { JiraClient } from "@/services/jira";
import { getState, setState } from "@/services/sync/state";
import {
  doneTransitions,
  dropComment,
  dropTransition,
  isCancelStatus,
  snoozeUntil,
} from "./closing";
import { snooze } from "./data";
import { SWEEP_STALE_KEY } from "./sweep";

/** The transitions that finish a ticket, read from Jira now (the workflow decides). */
export const doneOptions = (issueKey: string) =>
  Effect.gen(function* () {
    const all = yield* (yield* JiraClient).getTransitions(issueKey);
    return doneTransitions(all);
  });

export type ActionResult = {
  message: string;
  /** Something that did not happen though the action ran. */
  warning?: string;
};

const refreshWarning = (refreshed: boolean) =>
  refreshed ? undefined : "Saved in Jira; the local copy refreshes on the next sync.";

/** Moves a ticket through one transition the user picked. */
export const finishTicket = (issueKey: string, transition: { id: string; to: { name: string } }) =>
  Effect.gen(function* () {
    const r = yield* (yield* Executor).run({
      kind: "transition",
      issueKey,
      transitionId: transition.id,
      transitionName: transition.to.name,
    });
    return {
      message: `${issueKey} moved to ${transition.to.name}`,
      warning: refreshWarning(r.refreshed),
    } satisfies ActionResult;
  });

/**
 * Drops a ticket with a reason, as D43 requires: the cancel-like transition
 * when the workflow has one, else a done one, then a comment saying why. A
 * failed comment after the move is a warning, not a failure, so a retry does
 * not move it twice.
 */
export const dropTicket = (issueKey: string, reason: string) =>
  Effect.gen(function* () {
    const why = reason.trim();
    if (!why)
      return yield* new ExecutorError({ kind: "invalid", message: "Say why it is dropped." });
    const transitions = yield* (yield* JiraClient).getTransitions(issueKey);
    const t = dropTransition(transitions);
    if (!t)
      return yield* new ExecutorError({
        kind: "unsupported",
        message: `${issueKey} cannot be closed from its current status (available: ${transitions.map((x) => x.to.name).join(", ") || "none"}).`,
      });
    const executor = yield* Executor;
    const moved = yield* executor.run({
      kind: "transition",
      issueKey,
      transitionId: t.id,
      transitionName: t.to.name,
    });
    const cancelled = isCancelStatus(t.to.name) || isCancelStatus(t.name);
    const commented = yield* executor
      .run({ kind: "add_comment", issueKey, bodyMarkdown: dropComment(why, cancelled) })
      .pipe(
        Effect.map(() => null),
        Effect.catchAll((e) =>
          Effect.succeed(
            `Moved to ${t.to.name}, but the comment saying why failed (${e.message}); add it in the ticket.`,
          ),
        ),
      );
    return {
      message: `${issueKey} moved to ${t.to.name} with the reason`,
      warning: commented ?? refreshWarning(moved.refreshed),
    } satisfies ActionResult;
  });

/** "9 Oct" for a YYYY-MM-DD day. */
const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** Hides a ticket from Today until the start of `until` (YYYY-MM-DD); local only (FR-5.3). */
export const snoozeTicket = (issueKey: string, until: string) =>
  Effect.as(snooze(issueKey, snoozeUntil(until)), {
    message: `${issueKey} snoozed until ${day(until)}`,
  } satisfies ActionResult);

/** A wait's snooze: its next follow-up moves to `until`, so nothing is due before. */
export const snoozeWait = (dependencyId: string, label: string, until: string) =>
  Effect.as(setDates(dependencyId, { nextFollowupAt: until }), {
    message: `Next chase of ${label} on ${day(until)}`,
  } satisfies ActionResult);

/** They delivered: the wait is resolved (a mirrored remote link follows). */
export const resolveWait = (dependencyId: string, label: string) =>
  Effect.as(setStatus(dependencyId, "resolved"), {
    message: `${label} resolved`,
  } satisfies ActionResult);

/** No longer needed: the reason goes on the wait's timeline, then it is resolved. */
export const dropWait = (dependencyId: string, label: string, reason: string) =>
  Effect.gen(function* () {
    const why = reason.trim();
    if (!why)
      return yield* new ExecutorError({ kind: "invalid", message: "Say why it is dropped." });
    yield* logFollowup(dependencyId, {
      channel: "other",
      summary: `Stopped waiting: ${why}`,
      nextFollowupAt: null,
    });
    yield* setStatus(dependencyId, "resolved");
    return { message: `Stopped waiting on ${label}` } satisfies ActionResult;
  });

/** When the sweep's weekly pass over untouched asks last ran; null if never. */
export const lastStalePass = Effect.map(getState(SWEEP_STALE_KEY), (v) => v ?? null);

/** Records that the weekly pass ran. */
export const markStalePass = (at = new Date()) => setState(SWEEP_STALE_KEY, at.toISOString());

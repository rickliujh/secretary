/**
 * The writes that revoke an approval (D54 (3)): a Jira action through `run`, or
 * a local change Secretary made. The revoke planner (`proposals/revoke.ts`)
 * builds them; `Executor.reverse` performs one.
 */
import type { JiraAction } from "./actions";
import type { WaitState } from "./undo";

export type ReverseOp =
  | { kind: "jira"; action: JiraAction }
  /**
   * Moves an issue to a status by name. The transition is chosen from those
   * available when the step runs, since an earlier step may have moved the issue;
   * an issue already there is left as it is.
   */
  | { kind: "transition_to"; issueKey: string; status: string }
  /** Deletes a wait and the remote link that mirrors it. */
  | { kind: "delete_wait"; dependencyId: string }
  /**
   * Puts a wait's state back (null: leaves it, as it changed since) and removes
   * the timeline entry the approval added.
   */
  | {
      kind: "restore_wait";
      dependencyId: string;
      state: WaitState | null;
      followupId: string | null;
    }
  | { kind: "restore_person"; personId: string; set: Record<string, unknown> }
  | { kind: "restore_team"; teamId: string; set: Record<string, unknown> }
  | { kind: "delete_memory"; memoryId: string }
  /**
   * Drops a ticket that is already gone from Jira from the cache, with what
   * Secretary kept about it, as a delete through `run` does.
   */
  | { kind: "forget_issue"; issueKey: string }
  /** Deletes a draft that was neither sent nor copied. */
  | { kind: "delete_draft"; communicationId: string }
  /**
   * Deletes a contact or team an approval added (D60), checked again when it runs:
   * only while its columns still equal `created` and nothing uses it.
   */
  | { kind: "delete_person"; personId: string; created: Record<string, unknown> }
  | { kind: "delete_team"; teamId: string; created: Record<string, unknown> };

/** Columns of `people` and `teams` an approval may change, so a revoke restores only those. */
export const PERSON_COLUMNS = [
  "title",
  "responsibilities",
  "profile",
  "awayUntil",
  "notesMd",
  "teamId",
] as const;

/** Columns a new contact or team is written with (D60), compared before a revoke deletes it. */
export const CREATED_PERSON_COLUMNS = [
  "displayName",
  "jiraUsername",
  "email",
  "title",
  "teamId",
  "responsibilities",
  "profile",
  "notesMd",
  "awayUntil",
] as const;
export const CREATED_TEAM_COLUMNS = [
  "name",
  "function",
  "contactFor",
  "channel",
  "escalationPath",
  "confluenceUrls",
  "notesMd",
] as const;

/**
 * The columns of `row` that differ from what was written when it was added;
 * empty when it is unchanged. Values compare as JSON, a missing one as null.
 */
export function changedSince(
  row: Record<string, unknown>,
  created: Record<string, unknown>,
): string[] {
  return Object.keys(created).filter(
    (k) => JSON.stringify(row[k] ?? null) !== JSON.stringify(created[k] ?? null),
  );
}
export const TEAM_COLUMNS = [
  "function",
  "contactFor",
  "channel",
  "escalationPath",
  "notesMd",
] as const;

/** Keeps only the allowed columns of a stored restore. */
export function pickColumns(
  set: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(set).filter(([k]) => allowed.includes(k)));
}

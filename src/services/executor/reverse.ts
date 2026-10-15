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
  /** Deletes a draft that was neither sent nor copied. */
  | { kind: "delete_draft"; communicationId: string };

/** Columns of `people` and `teams` an approval may change, so a revoke restores only those. */
export const PERSON_COLUMNS = [
  "title",
  "responsibilities",
  "profile",
  "awayUntil",
  "notesMd",
] as const;
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

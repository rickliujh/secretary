/**
 * Revoking an approval (FR-14, D54 (2)): which proposals a revoke covers, in
 * what order, and the reverse steps of each, planned in pure code from the
 * stored proposal and its undo data plus facts read fresh from Jira and the
 * database (`revoke-facts.ts`). The facts are read before any step runs, so
 * `planRevoke` carries what each planned step leaves behind into the planning of
 * the next (a simulated state), and the confirmation shows the true end-to-end
 * plan. Steps name targets (a status, a value), never ids that depend on the
 * state Jira is in when they run. Nothing here writes; `Proposals.revoke` runs
 * the steps through `Executor.reverse`.
 */
import type { ReverseOp } from "@/services/executor/reverse";
import {
  type IssueField,
  type IssueFieldValues,
  type SprintRef,
  type Undo,
  type UndoOf,
  undoOf,
  type WaitState,
} from "@/services/executor/undo";
import { isRevokeStatus, revokeStatus } from "@/services/jira/cancel";
import {
  describePayload,
  issueRefs,
  type PayloadOf,
  type ProposalKind,
  type ProposalPayload,
} from "./schema";

/** The comment a revoked ticket gets when it is closed rather than deleted (D54). */
export const REVOKE_COMMENT = "Created by mistake and revoked in Secretary.";

/** A stored proposal as the planner sees it: the effective payload, refs as stored. */
export type RevokeSubject = {
  id: string;
  kind: string;
  status: string;
  payload: ProposalPayload;
  result: unknown;
  seq: number;
  decidedAt: string | null;
};

/** Kinds whose result holds what a revoke needs only from now on (D54 (1)). */
const NEEDS_UNDO: readonly ProposalKind[] = [
  "update_issue",
  "transition_issue",
  "move_to_sprint",
  "add_comment",
  "link_issues",
  "update_dependency",
  "update_person",
  "update_team",
];

type Ids = {
  issueKey?: string;
  dependencyId?: string;
  memoryId?: string;
  communicationId?: string;
};
const idsOf = (result: unknown): Ids => (result && typeof result === "object" ? result : {}) as Ids;

const BEFORE_UNDO = "Approved before undo was recorded, so it cannot be revoked here.";

/**
 * Why a proposal cannot be revoked, from what is stored alone; null when Revoke
 * may be offered. Facts read later can still make it impossible (a closed sprint,
 * a sent draft).
 */
export function revokeBlock(p: { kind: string; status: string; result: unknown }): string | null {
  if (p.status === "revoked") return "It is already revoked.";
  if (p.status !== "executed") return "Only an approval that ran can be revoked.";
  if (p.kind === "needs_clarification") return "An answered question has nothing to undo.";
  const ids = idsOf(p.result);
  if ((NEEDS_UNDO as readonly string[]).includes(p.kind) && !undoOf(p.result)) return BEFORE_UNDO;
  if (p.kind === "create_issue" && !ids.issueKey) return BEFORE_UNDO;
  if (p.kind === "link_dependency" && !ids.dependencyId) return BEFORE_UNDO;
  if (p.kind === "remember" && !ids.memoryId) return BEFORE_UNDO;
  if (p.kind === "draft_message" && !ids.communicationId) return BEFORE_UNDO;
  return null;
}

/** Why a draft cannot be revoked: it went out (FR-14.5). */
export const draftBlock = (status: string | null | undefined): string | null =>
  status === "sent" || status === "copied"
    ? `The draft was already ${status}; a message that went out cannot be taken back.`
    : null;

const closedSprint = (previous: SprintRef, key: string) =>
  `Sprint ${previous.name} has closed, so ${key} cannot go back to it.`;

/** Local data `localRevokeBlock` reads: a draft's status, a synced sprint's state. */
export type LocalRevokeData = {
  draftStatus: (communicationId: string) => string | null;
  sprintState: (sprintId: number) => string | null;
};

/**
 * Why a proposal cannot be revoked, from stored and local data (FR-14.5): what
 * `revokeBlock` rules out, a draft that was sent or copied, and a sprint move
 * whose earlier sprint has closed. Cheap enough to show on the card before the
 * confirmation opens; reasons that need Jira still show in the confirmation.
 */
export function localRevokeBlock(
  p: { kind: string; status: string; result: unknown },
  local: LocalRevokeData,
): string | null {
  const blocked = revokeBlock(p);
  if (blocked) return blocked;
  if (p.kind === "draft_message") {
    const id = idsOf(p.result).communicationId;
    return id ? draftBlock(local.draftStatus(id)) : null;
  }
  const u = undoOf(p.result);
  if (u?.kind === "move_to_sprint" && u.moved && u.previous)
    return local.sprintState(u.previous.id) === "closed"
      ? closedSprint(u.previous, u.issueKey)
      : null;
  return null;
}

const newestFirst = (a: RevokeSubject, b: RevokeSubject) =>
  (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || b.seq - a.seq;

/**
 * The executed proposals of the same thread that act on the issue a create made
 * (by its `$new` ref or its key), and on what those made in turn, newest first,
 * so each is undone before what it depends on (FR-14.4). Drafts only mention an
 * issue; they stay.
 */
export function cascadeOf(
  create: RevokeSubject,
  siblings: readonly RevokeSubject[],
): RevokeSubject[] {
  const found = new Map<string, RevokeSubject>();
  const visit = (c: RevokeSubject) => {
    if (c.payload.kind !== "create_issue") return;
    const names = new Set([c.payload.ref, idsOf(c.result).issueKey].filter((x) => !!x));
    for (const s of siblings) {
      if (s.id === create.id || found.has(s.id) || s.status !== "executed") continue;
      if (s.kind === "draft_message" || s.kind === "needs_clarification") continue;
      if (!issueRefs(s.payload).some((r) => names.has(r))) continue;
      found.set(s.id, s);
      visit(s);
    }
  };
  visit(create);
  return [...found.values()].sort(newestFirst);
}

// ---------------------------------------------------------------------------
// Facts: what is true now, read just before planning
// ---------------------------------------------------------------------------

export type IssueStatusNow = { name: string; category: string };

export type RevokeFacts =
  | {
      kind: "create_issue";
      exists: boolean;
      canDelete: boolean;
      /** Keys of its sub-tasks. */
      subtasks: string[];
      status: IssueStatusNow | null;
      /**
       * The statuses it can move to from `status`; null when not known, because
       * an earlier step of the revoke moves it first.
       */
      available: IssueStatusNow[] | null;
      /** Its project's statuses for its issue type, to plan from a status it is not in yet. */
      statuses: IssueStatusNow[];
      /** The issue already has the revoke comment (a resumed revoke). */
      commented: boolean;
    }
  | {
      kind: "update_issue";
      exists: boolean;
      values: IssueFieldValues;
      /** Display names of the users in `values`, by user id. */
      userNames?: Record<string, string>;
    }
  | {
      kind: "transition_issue";
      exists: boolean;
      status: string | null;
      /** Statuses it can move to from `status`; null when an earlier step moves it first. */
      available: string[] | null;
    }
  | {
      kind: "move_to_sprint";
      exists: boolean;
      current: SprintRef | null;
      /** The previous sprint's state as last synced ("closed", "active", "future"), null when unknown. */
      previousState: string | null;
    }
  | { kind: "add_comment"; exists: boolean }
  | { kind: "link_issues"; exists: boolean }
  | { kind: "link_dependency"; exists: boolean }
  | { kind: "update_dependency"; current: WaitState | null; followupExists: boolean }
  | { kind: "update_person"; current: Record<string, unknown> | null }
  | { kind: "update_team"; current: Record<string, unknown> | null }
  | { kind: "remember"; exists: boolean }
  | { kind: "draft_message"; status: "draft" | "copied" | "sent" | null };

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** One write: `text` for the confirmation, `done` for the record of what was undone. */
export type RevokeStep = { text: string; done: string; op: ReverseOp };

export type RevokeEntry = {
  proposalId: string;
  kind: string;
  /** What the approval did. */
  title: string;
  steps: RevokeStep[];
  /** Said in the confirmation without writing anything: already undone, gone. */
  notes: string[];
  /** Left as it is because it changed since the approval (FR-14.3); kept on the result. */
  warnings: string[];
  impossible: string | null;
};

export type RevokePlan = {
  proposalId: string;
  /** What acts on a revoked create first, newest first, then the proposal itself. */
  entries: RevokeEntry[];
  /** Why the proposal itself cannot be revoked; nothing runs then. */
  impossible: string | null;
};

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "(none)" : String(v));

const FIELD_LABELS: Record<IssueField, string> = {
  summary: "summary",
  priority: "priority",
  dueDate: "due date",
  assignee: "assignee",
};

const COLUMN_LABELS: Record<string, string> = {
  awayUntil: "away until",
  notesMd: "notes",
  contactFor: "contact for",
  escalationPath: "escalation path",
};
const columnLabel = (k: string) => COLUMN_LABELS[k] ?? k;

const jira = (action: Extract<ReverseOp, { kind: "jira" }>["action"]): ReverseOp => ({
  kind: "jira",
  action,
});

type Draft = Omit<RevokeEntry, "proposalId" | "kind" | "title">;
const empty = (): Draft => ({ steps: [], notes: [], warnings: [], impossible: null });

const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

function planCreate(key: string, f: Extract<RevokeFacts, { kind: "create_issue" }>): Draft {
  const d = empty();
  if (!f.exists) {
    d.notes.push(`${key} is already deleted.`);
    return d;
  }
  if (f.canDelete && f.subtasks.length === 0) {
    d.steps.push({
      text: `Delete ${key} in Jira`,
      done: `Deleted ${key}`,
      op: jira({ kind: "delete_issue", issueKey: key }),
    });
    return d;
  }
  d.notes.push(
    f.canDelete
      ? `${key} has sub-tasks, so it is closed rather than deleted.`
      : `You may not delete issues there, so ${key} is closed instead.`,
  );
  const closed = !!f.status && (f.status.category === "done" || isRevokeStatus(f.status.name));
  const target = closed ? null : revokeStatus(f.available ?? f.statuses);
  if (!closed && !target) {
    d.impossible = f.available
      ? `${key} has no transition to a cancelled or done status from ${f.status?.name ?? "its status"} (available: ${f.available.map((x) => x.name).join(", ") || "none"}).`
      : `${key} has no cancelled or done status to move to.`;
    return d;
  }
  if (!f.commented)
    d.steps.push({
      text: `Comment on ${key}: "${REVOKE_COMMENT}"`,
      done: `Commented on ${key}`,
      op: jira({ kind: "add_comment", issueKey: key, bodyMarkdown: REVOKE_COMMENT }),
    });
  if (closed) d.notes.push(`${key} is already ${f.status?.name}.`);
  else if (target)
    d.steps.push({
      text: `Move ${key} to ${target.name}`,
      done: `Moved ${key} to ${target.name}`,
      op: { kind: "transition_to", issueKey: key, status: target.name },
    });
  return d;
}

function planUpdateIssue(
  u: UndoOf<"update_issue">,
  f: Extract<RevokeFacts, { kind: "update_issue" }>,
  user: (id: string) => string | null,
): Draft {
  const d = empty();
  const key = u.issueKey;
  // A user by name: as Jira showed it now or at approval, else as Secretary knows them.
  const named = (id: string) => f.userNames?.[id] ?? u.names?.[id] ?? user(id) ?? id;
  const display = (k: IssueField, v: unknown) =>
    k === "assignee" && typeof v === "string" && v ? named(v) : v;
  if (!f.exists) {
    d.notes.push(`${key} no longer exists.`);
    return d;
  }
  const fields: { summary?: string; priority?: string; dueDate?: string | null } = {};
  const changed: string[] = [];
  let assign: { to: string | null } | null = null;
  for (const k of Object.keys(u.after) as IssueField[]) {
    const now = f.values[k];
    const before = u.before[k];
    if (same(now, before)) continue;
    const label = FIELD_LABELS[k];
    if (!same(now, u.after[k])) {
      d.warnings.push(
        `The ${label} of ${key} was changed since (now ${shown(display(k, now))}), so it stays as it is.`,
      );
      continue;
    }
    if (k === "assignee") {
      assign = { to: before ?? null };
      continue;
    }
    if (k === "dueDate") fields.dueDate = before ?? null;
    else if (before === null || before === undefined || before === "") {
      d.warnings.push(`The ${label} of ${key} had no value before, so it stays ${shown(now)}.`);
      continue;
    } else fields[k] = before;
    changed.push(`${label} back to ${shown(before)}`);
  }
  if (Object.keys(fields).length)
    d.steps.push({
      text: `Set the ${listed(changed)} on ${key}`,
      done: `Set the ${listed(changed)} on ${key}`,
      op: jira({ kind: "update_fields", issueKey: key, fields }),
    });
  if (assign)
    d.steps.push({
      text: assign.to ? `Assign ${key} back to ${named(assign.to)}` : `Unassign ${key}`,
      done: assign.to ? `Assigned ${key} back to ${named(assign.to)}` : `Unassigned ${key}`,
      op: jira({ kind: "assign", issueKey: key, username: assign.to }),
    });
  if (!d.steps.length && !d.warnings.length) d.notes.push(`${key} already has its earlier values.`);
  return d;
}

function planTransition(
  u: UndoOf<"transition_issue">,
  f: Extract<RevokeFacts, { kind: "transition_issue" }>,
): Draft {
  const d = empty();
  const key = u.issueKey;
  if (!f.exists) d.notes.push(`${key} no longer exists.`);
  else if (sameName(f.status, u.fromStatus)) d.notes.push(`${key} is already in ${u.fromStatus}.`);
  else if (!sameName(f.status, u.toStatus))
    d.warnings.push(
      `${key} was moved since (now ${shown(f.status)}), so it stays there rather than going back to ${u.fromStatus}.`,
    );
  else if (f.available && !f.available.some((x) => sameName(x, u.fromStatus)))
    d.impossible = `${key} cannot move back to ${u.fromStatus} from ${u.toStatus} (available: ${f.available.join(", ") || "none"}).`;
  else
    d.steps.push({
      text: `Move ${key} back to ${u.fromStatus}`,
      done: `Moved ${key} back to ${u.fromStatus}`,
      op: { kind: "transition_to", issueKey: key, status: u.fromStatus },
    });
  return d;
}

function planSprint(
  u: UndoOf<"move_to_sprint">,
  f: Extract<RevokeFacts, { kind: "move_to_sprint" }>,
): Draft {
  const d = empty();
  const key = u.issueKey;
  if (!u.moved) {
    d.notes.push(`${key} was already in the sprint; nothing was moved.`);
    return d;
  }
  if (u.previous === undefined) {
    d.impossible = `The sprint ${key} was in before was not recorded.`;
    return d;
  }
  const previous = u.previous;
  if (previous && f.previousState === "closed") d.impossible = closedSprint(previous, key);
  else if (!f.exists) d.notes.push(`${key} no longer exists.`);
  else if ((f.current?.id ?? null) === (previous?.id ?? null))
    d.notes.push(
      `${key} is already ${previous ? `in sprint ${previous.name}` : "in the backlog"}.`,
    );
  else if (f.current?.id !== u.sprintId)
    d.warnings.push(
      `${key} was moved since (now ${f.current ? `in sprint ${f.current.name}` : "in the backlog"}), so it stays there.`,
    );
  else if (!previous)
    d.steps.push({
      text: `Move ${key} back to the backlog`,
      done: `Moved ${key} back to the backlog`,
      op: jira({ kind: "move_to_backlog", issueKey: key }),
    });
  else
    d.steps.push({
      text: `Move ${key} back to sprint ${previous.name}`,
      done: `Moved ${key} back to sprint ${previous.name}`,
      op: jira({
        kind: "move_to_sprint",
        issueKey: key,
        sprintId: previous.id,
        sprintName: previous.name,
      }),
    });
  return d;
}

/** The wait columns a later change shows in; reminders stamp `notifiedOn` on their own. */
const waitFace = (w: WaitState) => ({
  status: w.status,
  expectedAt: w.expectedAt,
  nextFollowupAt: w.nextFollowupAt,
  resolvedAt: w.resolvedAt,
});

function planWaitUpdate(
  u: UndoOf<"update_dependency">,
  f: Extract<RevokeFacts, { kind: "update_dependency" }>,
  label: string,
): Draft {
  const d = empty();
  if (!u.before) {
    d.notes.push("Nothing was changed: the wait was already resolved.");
    return d;
  }
  if (!f.current) {
    d.notes.push("The wait no longer exists.");
    return d;
  }
  const back = same(waitFace(f.current), waitFace(u.before));
  const untouched = !!u.after && same(waitFace(f.current), waitFace(u.after));
  if (!back && !untouched)
    d.warnings.push(`${label} changed since, so its dates and status stay as they are.`);
  const followupId = f.followupExists ? u.followupId : null;
  if (untouched || followupId)
    d.steps.push({
      text: [
        untouched && `Put ${label} back as it was`,
        followupId && `remove the timeline entry it added`,
      ]
        .filter(Boolean)
        .join(" and "),
      done: `Put ${label} back`,
      op: {
        kind: "restore_wait",
        dependencyId: u.dependencyId,
        state: untouched ? u.before : null,
        followupId,
      },
    });
  if (!d.steps.length && !d.warnings.length) d.notes.push(`${label} is already as it was.`);
  return d;
}

function planColumns(
  u: UndoOf<"update_person"> | UndoOf<"update_team">,
  current: Record<string, unknown> | null,
  name: string,
): Draft {
  const d = empty();
  if (!current) {
    d.notes.push(`${name} no longer exists.`);
    return d;
  }
  const set: Record<string, unknown> = {};
  for (const [k, after] of Object.entries(u.after)) {
    const before = u.before[k] ?? null;
    if (same(current[k], before)) continue;
    if (!same(current[k], after)) {
      d.warnings.push(`The ${columnLabel(k)} of ${name} was changed since, so it stays as it is.`);
      continue;
    }
    set[k] = before;
  }
  const keys = Object.keys(set).map(columnLabel);
  if (keys.length) {
    const what = `the ${listed(keys)} of ${name}`;
    d.steps.push({
      text: `Put back ${what}`,
      done: `Put back ${what}`,
      op:
        u.kind === "update_person"
          ? { kind: "restore_person", personId: u.personId, set }
          : { kind: "restore_team", teamId: u.teamId, set },
    });
  } else if (!d.warnings.length) d.notes.push(`${name} already has its earlier values.`);
  return d;
}

/** Names the planner uses in texts, looked up by the caller. */
export type RevokeNames = {
  /** A contact's or team's display name by id. */
  subject?: (id: string) => string | null;
  /** A Jira user's display name by user id (username or accountId). */
  user?: (id: string) => string | null;
};

/**
 * The reverse steps of one executed proposal (D54 (3)), given what is true now.
 * `facts` must be of the proposal's kind; a mismatch (or none) is impossible.
 */
export function planEntry(
  s: RevokeSubject,
  facts: RevokeFacts | null,
  names: RevokeNames = {},
): RevokeEntry {
  const base = { proposalId: s.id, kind: s.kind, title: describePayload(s.payload) };
  const blocked = revokeBlock(s);
  if (blocked) return { ...base, ...empty(), impossible: blocked };
  const undo = undoOf(s.result);
  const ids = idsOf(s.result);
  const mismatch = (): Draft => ({ ...empty(), impossible: "Could not read what to undo." });
  const kindOf = <K extends Undo["kind"]>(k: K) =>
    undo?.kind === k ? (undo as UndoOf<K>) : undefined;
  const label = (p: PayloadOf<"update_dependency">) =>
    p.label ? `The wait on ${p.label}` : "The wait";
  const draft = ((): Draft => {
    if (!facts || facts.kind !== s.kind) return mismatch();
    switch (facts.kind) {
      case "create_issue":
        return planCreate(ids.issueKey ?? "", facts);
      case "update_issue": {
        const u = kindOf("update_issue");
        return u ? planUpdateIssue(u, facts, (id) => names.user?.(id) ?? null) : mismatch();
      }
      case "transition_issue": {
        const u = kindOf("transition_issue");
        return u ? planTransition(u, facts) : mismatch();
      }
      case "move_to_sprint": {
        const u = kindOf("move_to_sprint");
        return u ? planSprint(u, facts) : mismatch();
      }
      case "add_comment": {
        const u = kindOf("add_comment");
        if (!u) return mismatch();
        const d = empty();
        if (facts.exists)
          d.steps.push({
            text: `Delete the comment on ${u.issueKey}`,
            done: `Deleted the comment on ${u.issueKey}`,
            op: jira({ kind: "delete_comment", issueKey: u.issueKey, commentId: u.commentId }),
          });
        else d.notes.push(`The comment on ${u.issueKey} is already deleted.`);
        return d;
      }
      case "link_issues": {
        const u = kindOf("link_issues");
        if (!u) return mismatch();
        const d = empty();
        const p = s.payload.kind === "link_issues" ? s.payload : null;
        const what = p ? `the link "${p.target} is blocked by ${p.blocker}"` : "the link";
        if (!u.linkId) d.notes.push(`Jira had ${what} before the approval, so it stays.`);
        else if (!facts.exists)
          d.notes.push(`${what[0]?.toUpperCase()}${what.slice(1)} is already removed.`);
        else
          d.steps.push({
            text: `Remove ${what}`,
            done: `Removed ${what}`,
            op: jira({ kind: "delete_issue_link", issueKey: u.issueKey, linkId: u.linkId }),
          });
        return d;
      }
      case "link_dependency": {
        const d = empty();
        const p = s.payload.kind === "link_dependency" ? s.payload : null;
        const what = p ? `the wait on ${p.label}` : "the wait";
        if (facts.exists)
          d.steps.push({
            text: `Delete ${what}`,
            done: `Deleted ${what}`,
            op: { kind: "delete_wait", dependencyId: ids.dependencyId ?? "" },
          });
        else d.notes.push(`${what[0]?.toUpperCase()}${what.slice(1)} is already deleted.`);
        return d;
      }
      case "update_dependency": {
        const u = kindOf("update_dependency");
        const p = s.payload.kind === "update_dependency" ? s.payload : null;
        return u && p ? planWaitUpdate(u, facts, label(p)) : mismatch();
      }
      case "update_person": {
        const u = kindOf("update_person");
        return u
          ? planColumns(u, facts.current, names.subject?.(u.personId) ?? "the contact")
          : mismatch();
      }
      case "update_team": {
        const u = kindOf("update_team");
        return u
          ? planColumns(u, facts.current, names.subject?.(u.teamId) ?? "the team")
          : mismatch();
      }
      case "remember": {
        const d = empty();
        if (facts.exists)
          d.steps.push({
            text: "Forget the memory",
            done: "Forgot the memory",
            op: { kind: "delete_memory", memoryId: ids.memoryId ?? "" },
          });
        else d.notes.push("The memory is already deleted.");
        return d;
      }
      case "draft_message": {
        const d = empty();
        const sent = draftBlock(facts.status);
        if (sent) d.impossible = sent;
        else if (facts.status === "draft")
          d.steps.push({
            text: "Delete the draft",
            done: "Deleted the draft",
            op: { kind: "delete_draft", communicationId: ids.communicationId ?? "" },
          });
        else d.notes.push("The draft is already deleted.");
        return d;
      }
    }
  })();
  return { ...base, ...draft };
}

// ---------------------------------------------------------------------------
// The simulated state: what the steps planned so far leave behind
// ---------------------------------------------------------------------------

type IssueSim = {
  deleted?: boolean;
  status?: string;
  values: IssueFieldValues;
  /** The open sprint it ends in; null = the backlog. */
  sprint?: SprintRef | null;
};

type Sim = {
  issues: Map<string, IssueSim>;
  /** A wait's state after the planned steps; null = deleted. */
  waits: Map<string, WaitState | null>;
  followupsGone: Set<string>;
  /** A contact's or team's columns put back, by id. */
  columns: Map<string, Record<string, unknown>>;
};

const newSim = (): Sim => ({
  issues: new Map(),
  waits: new Map(),
  followupsGone: new Set(),
  columns: new Map(),
});

const issueSim = (sim: Sim, key: string): IssueSim => {
  const found = sim.issues.get(key);
  if (found) return found;
  const made: IssueSim = { values: {} };
  sim.issues.set(key, made);
  return made;
};

const ISSUE_FIELDS: readonly IssueField[] = ["summary", "priority", "dueDate", "assignee"];

/** Records what an entry's steps leave behind, for planning the entries after it. */
function applySteps(sim: Sim, steps: readonly RevokeStep[]) {
  for (const { op } of steps) {
    switch (op.kind) {
      case "transition_to":
        issueSim(sim, op.issueKey).status = op.status;
        break;
      case "delete_wait":
        sim.waits.set(op.dependencyId, null);
        break;
      case "restore_wait":
        if (op.state) sim.waits.set(op.dependencyId, op.state);
        if (op.followupId) sim.followupsGone.add(op.followupId);
        break;
      case "restore_person":
      case "restore_team": {
        const id = op.kind === "restore_person" ? op.personId : op.teamId;
        sim.columns.set(id, { ...sim.columns.get(id), ...op.set });
        break;
      }
      case "jira": {
        const a = op.action;
        if (a.kind === "delete_issue") issueSim(sim, a.issueKey).deleted = true;
        if (a.kind === "update_fields") {
          const values = issueSim(sim, a.issueKey).values;
          for (const k of ISSUE_FIELDS)
            if (k !== "assignee" && k in a.fields) Object.assign(values, { [k]: a.fields[k] });
        }
        if (a.kind === "assign") issueSim(sim, a.issueKey).values.assignee = a.username;
        if (a.kind === "move_to_sprint")
          issueSim(sim, a.issueKey).sprint = { id: a.sprintId, name: a.sprintName ?? "" };
        if (a.kind === "move_to_backlog") issueSim(sim, a.issueKey).sprint = null;
        break;
      }
      default:
        break;
    }
  }
}

/** The category of a status by name, from what the facts know of it. */
const categoryOf = (name: string, f: Extract<RevokeFacts, { kind: "create_issue" }>) =>
  [...f.statuses, ...(f.available ?? []), ...(f.status ? [f.status] : [])].find((x) =>
    sameName(x.name, name),
  )?.category ?? "";

/** The facts as they will be once the steps planned before this entry have run. */
function simulated(s: RevokeSubject, f: RevokeFacts, sim: Sim): RevokeFacts {
  const undo = undoOf(s.result);
  const key =
    f.kind === "create_issue"
      ? idsOf(s.result).issueKey
      : undo && "issueKey" in undo
        ? undo.issueKey
        : undefined;
  const i = key ? sim.issues.get(key) : undefined;
  const exists = (e: boolean) => e && !i?.deleted;
  switch (f.kind) {
    case "create_issue": {
      const moved = i?.status !== undefined && !sameName(i.status, f.status?.name);
      return {
        ...f,
        exists: exists(f.exists),
        subtasks: f.subtasks.filter((k) => !sim.issues.get(k)?.deleted),
        ...(moved && i?.status
          ? { status: { name: i.status, category: categoryOf(i.status, f) }, available: null }
          : {}),
      };
    }
    case "update_issue": {
      const values = { ...f.values };
      for (const k of Object.keys(f.values) as IssueField[])
        if (i && k in i.values) Object.assign(values, { [k]: i.values[k] });
      return { ...f, exists: exists(f.exists), values };
    }
    case "transition_issue": {
      const moved = i?.status !== undefined && !sameName(i.status, f.status);
      return {
        ...f,
        exists: exists(f.exists),
        ...(moved && i?.status ? { status: i.status, available: null } : {}),
      };
    }
    case "move_to_sprint":
      return {
        ...f,
        exists: exists(f.exists),
        current: i && i.sprint !== undefined ? i.sprint : f.current,
      };
    case "add_comment":
    case "link_issues":
      return { ...f, exists: exists(f.exists) };
    case "link_dependency":
      return {
        ...f,
        exists: f.exists && sim.waits.get(idsOf(s.result).dependencyId ?? "") !== null,
      };
    case "update_dependency": {
      if (undo?.kind !== "update_dependency") return f;
      const id = undo.dependencyId;
      return {
        ...f,
        current: sim.waits.has(id) ? (sim.waits.get(id) ?? null) : f.current,
        followupExists:
          f.followupExists && !(undo.followupId && sim.followupsGone.has(undo.followupId)),
      };
    }
    case "update_person":
    case "update_team": {
      const id =
        undo?.kind === "update_person"
          ? undo.personId
          : undo?.kind === "update_team"
            ? undo.teamId
            : "";
      const put = sim.columns.get(id);
      return put && f.current ? { ...f, current: { ...f.current, ...put } } : f;
    }
    default:
      return f;
  }
}

/**
 * The whole plan: what acts on a revoked create first (each with its own facts),
 * then the proposal itself. Each entry is planned against the facts as the steps
 * planned before it leave them (a status moved back, a sub-task deleted, a value
 * put back), so the plan is true end to end although every fact was read before
 * any step runs. A cascaded proposal that cannot be undone is left as it is and
 * says why; only the proposal's own impossibility stops the revoke.
 */
export function planRevoke(
  subject: RevokeSubject,
  cascade: readonly RevokeSubject[],
  facts: ReadonlyMap<string, RevokeFacts>,
  names: RevokeNames = {},
): RevokePlan {
  const sim = newSim();
  const entries = [...cascade, subject].map((s) => {
    const f = facts.get(s.id);
    const e = planEntry(s, f ? simulated(s, f, sim) : null, names);
    if (!e.impossible) applySteps(sim, e.steps);
    return e;
  });
  const own = entries.at(-1);
  return { proposalId: subject.id, entries, impossible: own?.impossible ?? null };
}

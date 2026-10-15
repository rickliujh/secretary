/**
 * What is true now for each proposal a revoke covers (D54 (2)): fresh reads
 * from Jira (never the cache) and the database, for the pure planner in
 * `revoke.ts`. Reads only; a 404 means the thing is gone.
 */
import { eq, inArray } from "drizzle-orm";
import { Effect, Option } from "effect";
import { communications, dependencies, followups, memories, people, teams } from "@/db/schema";
import { query } from "@/services/db";
import {
  issueFieldIds,
  issueFieldValues,
  issueStatus,
  issueUserNames,
  openSprint,
  undoOf,
} from "@/services/executor/undo";
import { JiraClient, type JiraError } from "@/services/jira";
import { NamedSchema, parseIssueLinks } from "@/services/jira/schemas";
import { Sync } from "@/services/sync";
import { getState, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import {
  type IssueStatusNow,
  type LocalRevokeData,
  REVOKE_COMMENT,
  type RevokeFacts,
  type RevokeSubject,
} from "./revoke";

/** Succeeds with none when Jira answers 404 (the issue or comment is gone). */
const unlessGone = <A, R>(e: Effect.Effect<A, JiraError, R>) =>
  e.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (err) => err.status === 404,
      () => Effect.succeed(Option.none<A>()),
    ),
  );

const ids = (result: unknown) =>
  (result && typeof result === "object" ? result : {}) as {
    issueKey?: string;
    dependencyId?: string;
    memoryId?: string;
    communicationId?: string;
  };

/** Whether an issue already has the revoke comment, looking at its newest comments. */
export const hasRevokeComment = (key: string) =>
  Effect.gen(function* () {
    const jira = yield* JiraClient;
    const first = yield* jira.getComments(key, 0);
    const page =
      first.total > first.comments.length
        ? yield* jira.getComments(key, Math.max(0, first.total - 100))
        : first;
    return page.comments.some((c) => c.body.includes(REVOKE_COMMENT.slice(0, -1)));
  });

/**
 * The statuses of an issue's project for its issue type (all of the project's
 * when the type is not listed), to plan a move from a status the revoke moves
 * it to first. Empty when Jira does not say.
 */
const typeStatuses = (fields: Record<string, unknown>) =>
  Effect.gen(function* () {
    const project = (fields.project as { key?: unknown } | null)?.key;
    if (typeof project !== "string") return [];
    const type = NamedSchema.safeParse(fields.issuetype).data?.name;
    const all = yield* (yield* JiraClient)
      .projectStatuses(project)
      .pipe(Effect.orElseSucceed(() => []));
    const own = all.filter((t) => t.name === type);
    const seen = new Map<string, IssueStatusNow>();
    for (const t of own.length ? own : all)
      for (const st of t.statuses)
        if (!seen.has(st.name.toLowerCase()))
          seen.set(st.name.toLowerCase(), {
            name: st.name,
            category: st.statusCategory?.key ?? "",
          });
    return [...seen.values()];
  });

/** The facts for one proposal of a known kind; null for a kind with nothing to read. */
export const revokeFacts = (s: RevokeSubject) =>
  Effect.gen(function* () {
    const jira = yield* JiraClient;
    const undo = undoOf(s.result);
    switch (s.kind) {
      case "create_issue": {
        const key = ids(s.result).issueKey;
        if (!key) return null;
        const raw = yield* unlessGone(
          jira.getIssue(key, { fields: ["status", "subtasks", "issuetype", "project"] }),
        );
        if (Option.isNone(raw))
          return {
            kind: "create_issue",
            exists: false,
            canDelete: false,
            subtasks: [],
            status: null,
            available: [],
            statuses: [],
            commented: false,
          } satisfies RevokeFacts;
        const fields = raw.value.fields;
        const subtasks = Array.isArray(fields.subtasks)
          ? fields.subtasks.flatMap((x) =>
              x && typeof x === "object" && typeof (x as { key?: unknown }).key === "string"
                ? [(x as { key: string }).key]
                : [],
            )
          : [];
        const canDelete =
          (yield* jira.myPermissions(key, ["DELETE_ISSUES"])).DELETE_ISSUES === true;
        // Deleted outright: no status to plan. A sub-task the revoke deletes first
        // still counts here; the planner takes it off.
        const deletes = canDelete && subtasks.length === 0;
        const transitions = deletes ? [] : yield* jira.getTransitions(key);
        return {
          kind: "create_issue",
          exists: true,
          canDelete,
          subtasks,
          status: issueStatus(fields),
          available: transitions.map((t) => ({
            name: t.to.name,
            category: t.to.statusCategory?.key ?? "",
          })),
          statuses: deletes ? [] : yield* typeStatuses(fields),
          commented: deletes ? false : yield* hasRevokeComment(key),
        } satisfies RevokeFacts;
      }
      case "update_issue": {
        if (undo?.kind !== "update_issue") return null;
        const keys = Object.keys(undo.after) as (keyof typeof undo.after)[];
        const raw = yield* unlessGone(
          jira.getIssue(undo.issueKey, { fields: issueFieldIds(keys, undo.pointsField) }),
        );
        return {
          kind: "update_issue",
          exists: Option.isSome(raw),
          values: Option.isSome(raw)
            ? issueFieldValues(raw.value.fields, keys, undo.pointsField)
            : {},
          userNames: Option.isSome(raw) ? issueUserNames(raw.value.fields, keys) : {},
        } satisfies RevokeFacts;
      }
      case "transition_issue": {
        if (undo?.kind !== "transition_issue") return null;
        const raw = yield* unlessGone(jira.getIssue(undo.issueKey, { fields: ["status"] }));
        if (Option.isNone(raw))
          return {
            kind: "transition_issue",
            exists: false,
            status: null,
            available: [],
          } satisfies RevokeFacts;
        const transitions = yield* jira.getTransitions(undo.issueKey);
        return {
          kind: "transition_issue",
          exists: true,
          status: issueStatus(raw.value.fields)?.name ?? null,
          available: transitions.map((t) => t.to.name),
        } satisfies RevokeFacts;
      }
      case "move_to_sprint": {
        if (undo?.kind !== "move_to_sprint") return null;
        const sprintField = (yield* (yield* Sync).fieldInfo).effective.sprint;
        const raw = sprintField
          ? yield* unlessGone(jira.getIssue(undo.issueKey, { fields: [sprintField] }))
          : Option.none();
        const sprints = parseSprintState(yield* getState(SYNC_KEYS.sprints)).sprints;
        const previousId = undo.previous?.id;
        return {
          kind: "move_to_sprint",
          exists: Option.isSome(raw),
          current:
            Option.isSome(raw) && sprintField ? openSprint(raw.value.fields[sprintField]) : null,
          previousState: sprints.find((x) => x.id === previousId)?.state ?? null,
        } satisfies RevokeFacts;
      }
      case "add_comment": {
        if (undo?.kind !== "add_comment") return null;
        const c = yield* unlessGone(jira.getComment(undo.issueKey, undo.commentId));
        return { kind: "add_comment", exists: Option.isSome(c) } satisfies RevokeFacts;
      }
      case "link_issues": {
        if (undo?.kind !== "link_issues") return null;
        if (!undo.linkId) return { kind: "link_issues", exists: false } satisfies RevokeFacts;
        const raw = yield* unlessGone(jira.getIssue(undo.issueKey, { fields: ["issuelinks"] }));
        return {
          kind: "link_issues",
          exists:
            Option.isSome(raw) &&
            parseIssueLinks(raw.value.fields.issuelinks).some((l) => l.id === undo.linkId),
        } satisfies RevokeFacts;
      }
      case "link_dependency": {
        const id = ids(s.result).dependencyId ?? "";
        const row = yield* query((d) =>
          d.select({ id: dependencies.id }).from(dependencies).where(eq(dependencies.id, id)).get(),
        );
        return { kind: "link_dependency", exists: !!row } satisfies RevokeFacts;
      }
      case "update_dependency": {
        if (undo?.kind !== "update_dependency") return null;
        const row = yield* query((d) =>
          d.select().from(dependencies).where(eq(dependencies.id, undo.dependencyId)).get(),
        );
        const followupId = undo.followupId;
        const entry = followupId
          ? yield* query((d) =>
              d
                .select({ id: followups.id })
                .from(followups)
                .where(eq(followups.id, followupId))
                .get(),
            )
          : undefined;
        return {
          kind: "update_dependency",
          current: row
            ? {
                status: row.status,
                expectedAt: row.expectedAt,
                nextFollowupAt: row.nextFollowupAt,
                resolvedAt: row.resolvedAt,
                notifiedOn: row.notifiedOn,
              }
            : null,
          followupExists: !!entry,
        } satisfies RevokeFacts;
      }
      case "update_person": {
        if (undo?.kind !== "update_person") return null;
        const row = yield* query((d) =>
          d.select().from(people).where(eq(people.id, undo.personId)).get(),
        );
        return { kind: "update_person", current: row ?? null } satisfies RevokeFacts;
      }
      case "update_team": {
        if (undo?.kind !== "update_team") return null;
        const row = yield* query((d) =>
          d.select().from(teams).where(eq(teams.id, undo.teamId)).get(),
        );
        return { kind: "update_team", current: row ?? null } satisfies RevokeFacts;
      }
      case "remember": {
        const id = ids(s.result).memoryId ?? "";
        const row = yield* query((d) =>
          d.select({ id: memories.id }).from(memories).where(eq(memories.id, id)).get(),
        );
        return { kind: "remember", exists: !!row } satisfies RevokeFacts;
      }
      case "draft_message": {
        const id = ids(s.result).communicationId ?? "";
        const row = yield* query((d) =>
          d
            .select({ status: communications.status })
            .from(communications)
            .where(eq(communications.id, id))
            .get(),
        );
        return { kind: "draft_message", status: row?.status ?? null } satisfies RevokeFacts;
      }
      default:
        return null;
    }
  });

/**
 * What `localRevokeBlock` reads for these proposals (FR-14.5): the status of the
 * drafts they made and the synced state of the sprints they left. Database only.
 */
export const localRevokeData = (
  rows: readonly { kind: string; status: string; result: unknown }[],
) =>
  Effect.gen(function* () {
    const executed = rows.filter((r) => r.status === "executed");
    const draftIds = executed.flatMap((r) =>
      r.kind === "draft_message" && ids(r.result).communicationId
        ? [ids(r.result).communicationId ?? ""]
        : [],
    );
    const drafts = new Map<string, string>();
    if (draftIds.length)
      for (const c of yield* query((d) =>
        d
          .select({ id: communications.id, status: communications.status })
          .from(communications)
          .where(inArray(communications.id, draftIds))
          .all(),
      ))
        drafts.set(c.id, c.status);
    const sprints = executed.some((r) => r.kind === "move_to_sprint")
      ? parseSprintState(yield* getState(SYNC_KEYS.sprints)).sprints
      : [];
    return {
      draftStatus: (id) => drafts.get(id) ?? null,
      sprintState: (id) => sprints.find((x) => x.id === id)?.state ?? null,
    } satisfies LocalRevokeData;
  });

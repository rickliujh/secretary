import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { Cause, Effect, Layer } from "effect";
import {
  actionsLog,
  communications,
  dependencies,
  followups,
  issueMeta,
  jiraIssues,
  memories,
  people,
  proposals,
  teams,
} from "@/db/schema";
import { addBusinessDays, localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redactValue } from "@/lib/redact";
import { wikiSafetyWarning } from "@/lib/wiki-safe";
import { parseLinkTypes } from "@/services/blockers/logic";
import { type BlockLink, blockLinks } from "@/services/dashboard/sections";
import { bindDb, Db } from "@/services/db";
import { nextFollowupAfter } from "@/services/dependencies/logic";
import {
  deleteDependency,
  logFollowup,
  mirror,
  setDates,
  setStatus,
} from "@/services/dependencies/queries";
import { CreatedIssueSchema, JiraClient, JiraError } from "@/services/jira";
import { parseIssueLinks } from "@/services/jira/schemas";
import {
  describeWaitUpdate,
  issueRefs,
  type PayloadOf,
  type ProposalPayload,
} from "@/services/proposals/schema";
import { Settings, settingsOrDefault } from "@/services/settings";
import { userActiveSprints } from "@/services/sprints/active";
import { Sync } from "@/services/sync";
import { forgetDeleted } from "@/services/sync/deleted";
import { getState, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import {
  describeAction,
  Executor,
  ExecutorError,
  type ExecutorShape,
  type JiraAction,
  JiraActionSchema,
  type ProposalResult,
} from ".";
import {
  buildCreateIssue,
  buildJiraWrite,
  droppedFieldsWarning,
  MappingError,
  proposalTextToWiki,
} from "./jira-mapping";
import { PERSON_COLUMNS, pickColumns, type ReverseOp, TEAM_COLUMNS } from "./reverse";
import {
  ISSUE_FIELD_IDS,
  type IssueField,
  type IssueFieldValues,
  issueFieldValues,
  issueStatus,
  issueUserNames,
  openSprint,
  type Undo,
  type UndoOf,
  undoOf,
  type WaitState,
} from "./undo";

/** A wait's state columns, as update_dependency's undo keeps them (D54). */
const waitState = (d: typeof dependencies.$inferSelect): WaitState => ({
  status: d.status,
  expectedAt: d.expectedAt,
  nextFollowupAt: d.nextFollowupAt,
  resolvedAt: d.resolvedAt,
  notifiedOn: d.notifiedOn,
});

/** The columns a local update changes, before and after, for revoking it (D54). */
const changedColumns = (row: Record<string, unknown>, set: Record<string, unknown>) => {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    const was = row[k] ?? null;
    if (JSON.stringify(was) === JSON.stringify(v ?? null)) continue;
    before[k] = was;
    after[k] = v ?? null;
  }
  return { before, after };
};

const make = Effect.gen(function* () {
  const jira = yield* JiraClient;
  const sync = yield* Sync;
  const settings = yield* Settings;
  const db = yield* Db;
  const { q, withDb } = bindDb(db);

  const log = (row: Omit<typeof actionsLog.$inferInsert, "id" | "at">) =>
    Effect.gen(function* () {
      const id = newId();
      yield* q((d) =>
        d.insert(actionsLog).values({
          ...row,
          id,
          request: redactValue(row.request),
          response: redactValue(row.response),
          at: nowIso(),
        }),
      );
      return id;
    });

  const fail = (kind: "invalid" | "unsupported", message: string) =>
    new ExecutorError({ kind, message });

  /** Records a local (non-Jira) write in the audit log. */
  const audit = (
    proposalId: string,
    action: string,
    target: string,
    request: unknown,
    response: unknown,
  ) => log({ proposalId, action, target, request, response, ok: true });

  const appendNote = (existing: string | null, note: string | null) =>
    note ? `${existing ? `${existing.trimEnd()}\n\n` : ""}- ${localDate()}: ${note}` : existing;

  /**
   * Jira users a mention in proposal text may name (D51): contacts with a Jira
   * id, the issue's assignee and reporter (from the cache, or as given for a new
   * issue), and the user, who is the reporter of anything they create.
   */
  const knownJiraUsers = (issueKey: string | null, extra: readonly (string | null)[] = []) =>
    Effect.gen(function* () {
      const me = yield* withDb(getState(SYNC_KEYS.username));
      const contacts = yield* q((d) =>
        d
          .select({ id: people.jiraUsername })
          .from(people)
          .where(isNotNull(people.jiraUsername))
          .all(),
      );
      const issue = issueKey
        ? yield* q((d) =>
            d
              .select({ assignee: jiraIssues.assignee, reporter: jiraIssues.reporter })
              .from(jiraIssues)
              .where(eq(jiraIssues.key, issueKey))
              .get(),
          )
        : undefined;
      return [
        me ?? null,
        ...contacts.map((c) => c.id),
        issue?.assignee ?? null,
        issue?.reporter ?? null,
        ...extra,
      ];
    });

  /**
   * Removes a deleted issue from the cache, with its comments and Secretary's notes
   * on it, and keeps its tombstone so no sync stores it again and no thread offers
   * it (FR-14.6).
   */
  const forgetIssue = (key: string, proposalId: string | null) =>
    withDb(forgetDeleted(key, proposalId));

  /**
   * The undo data an earlier attempt of this proposal recorded (D54): a retry
   * after a failed step keeps what the first attempt read before it wrote.
   */
  const priorUndo = <K extends Undo["kind"]>(proposalId: string, kind: K) =>
    Effect.map(
      q((d) =>
        d
          .select({ result: proposals.result })
          .from(proposals)
          .where(eq(proposals.id, proposalId))
          .get(),
      ),
      (row): UndoOf<K> | null => {
        const u = undoOf(row?.result);
        return u?.kind === kind ? (u as UndoOf<K>) : null;
      },
    );

  /**
   * Keeps the undo data on the proposal before the writes start, so a step that
   * fails part way does not lose what the first attempt replaced (`Proposals.approve`
   * keeps it on the failed result).
   */
  const keepUndo = (proposalId: string, undo: Undo) =>
    q((d) => d.update(proposals).set({ result: { undo } }).where(eq(proposals.id, proposalId)));

  /** A single user-initiated or approved Jira write: validate, send, log, re-fetch. */
  const run = (input: JiraAction, opts: { proposalId?: string } = {}) =>
    Effect.gen(function* () {
      const parsed = JiraActionSchema.safeParse(input);
      if (!parsed.success) {
        return yield* new ExecutorError({
          kind: "invalid",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const action = parsed.data;
      const { effective: fieldIds } = yield* sync.fieldInfo;
      const deployment = yield* jira.deployment;
      const editMeta =
        action.kind === "set_epic" && deployment === "datacenter"
          ? yield* jira.getEditMeta(action.issueKey)
          : undefined;
      const request = yield* Effect.try({
        try: () => buildJiraWrite(action, { deployment, fieldIds, editMeta }),
        catch: (e) =>
          new ExecutorError({
            kind: e instanceof MappingError ? "unsupported" : "invalid",
            message: e instanceof Error ? e.message : String(e),
          }),
      });

      const response = yield* jira.send(request).pipe(
        Effect.tapError((e) =>
          log({
            proposalId: opts.proposalId ?? null,
            action: action.kind,
            target: action.issueKey,
            request,
            response: { error: e.message, status: e.status ?? null },
            ok: false,
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      );
      const actionLogId = yield* log({
        proposalId: opts.proposalId ?? null,
        action: action.kind,
        target: action.issueKey,
        request,
        response,
        ok: true,
      });
      logger.info(`${describeAction(action)}: done`);

      // A deleted issue leaves the cache with what Secretary kept about it (D54).
      if (action.kind === "delete_issue")
        yield* forgetIssue(action.issueKey, opts.proposalId ?? null);
      // Show Jira's truth after every write (design.md 7.3). Remote links are
      // not part of the cached issue, so those writes need no re-fetch.
      const touchesIssue =
        action.kind !== "upsert_remote_link" &&
        action.kind !== "delete_remote_link" &&
        action.kind !== "delete_issue";
      const refreshed = yield* (
        touchesIssue ? sync.refreshIssue(action.issueKey) : Effect.void
      ).pipe(
        Effect.as(true),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            logger.warn(`Re-fetch of ${action.issueKey} failed`, e.message);
            return false;
          }),
        ),
      );
      return { actionLogId, response, refreshed };
    });

  const createIssue = (p: Extract<ProposalPayload, { kind: "create_issue" }>, proposalId: string) =>
    Effect.gen(function* () {
      const { effective: fieldIds } = yield* sync.fieldInfo;
      const types = yield* jira.createMetaIssueTypes(p.projectKey);
      const type = types.find((t) => t.name.toLowerCase() === p.issueType.toLowerCase());
      if (!type) {
        return yield* fail(
          "unsupported",
          `${p.projectKey} has no issue type "${p.issueType}" (available: ${types.map((t) => t.name).join(", ")}).`,
        );
      }
      const fields = yield* jira.createMetaFields(p.projectKey, type.id);
      const deployment = yield* jira.deployment;
      const knownUsers = yield* knownJiraUsers(null, [p.assignee]);
      const plan = yield* Effect.try({
        try: () =>
          buildCreateIssue(
            {
              projectKey: p.projectKey,
              issueTypeId: type.id,
              issueTypeName: type.name,
              subtask: type.subtask,
              summary: p.summary,
              descriptionMd: p.descriptionMd,
              parent: p.parent,
              epic: p.epic,
              priority: p.priority,
              assignee: p.assignee,
              dueDate: p.dueDate,
              labels: p.labels,
            },
            { deployment, fieldIds, fields, knownUsers },
          ),
        catch: (e) => fail("unsupported", e instanceof Error ? e.message : String(e)),
      });
      const response = yield* jira.send(plan.request).pipe(
        Effect.tapError((e) =>
          log({
            proposalId,
            action: "create_issue",
            target: p.projectKey,
            request: plan.request,
            response: { error: e.message },
            ok: false,
          }).pipe(Effect.ignore),
        ),
      );
      const created = CreatedIssueSchema.safeParse(response);
      if (!created.success)
        return yield* fail("invalid", "Jira created the issue but did not return its key.");
      const key = created.data.key;
      // The issue exists from here on: nothing below may fail the proposal, or a
      // retry would create it again. Each later step that fails is a warning.
      const warnings: string[] = [];
      const afterCreate = <A>(what: string, step: Effect.Effect<A, unknown>) =>
        step.pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              const e = Cause.squash(cause);
              const reason = e instanceof Error ? e.message : String(e);
              logger.warn(`${key}: ${what} failed`, reason);
              warnings.push(`${key} was created, but ${what} failed: ${reason}`);
              return undefined;
            }),
          ),
        );
      yield* afterCreate(
        "recording the create in the action log",
        log({
          proposalId,
          action: "create_issue",
          target: key,
          request: plan.request,
          response,
          ok: true,
        }),
      );
      yield* sync.refreshIssue(key).pipe(Effect.ignore);
      if (plan.epicAfterCreate)
        yield* afterCreate(
          `linking it to epic ${plan.epicAfterCreate}`,
          run({ kind: "set_epic", issueKey: key, epicKey: plan.epicAfterCreate }, { proposalId }),
        );
      const dropped = droppedFieldsWarning(plan.dropped, `${type.name}`, p.projectKey);
      if (dropped) warnings.push(dropped);
      const madeSafe = wikiSafetyWarning(plan.safety, "description");
      if (madeSafe) warnings.push(madeSafe);
      // Who asked, so "what do I owe Dana" can be answered locally (FR-10.4).
      if (p.requesterPersonId) {
        const requesterPersonId = p.requesterPersonId;
        yield* afterCreate(
          "remembering who asked",
          q((d) =>
            d
              .insert(issueMeta)
              .values({ issueKey: key, requesterPersonId })
              .onConflictDoUpdate({ target: issueMeta.issueKey, set: { requesterPersonId } }),
          ),
        );
      }
      let message = `Created ${key}`;
      // A failed sprint move is a warning, not a failure (D44). Sub-tasks follow their parent.
      if (p.joinSprint && !type.subtask) {
        const joined = yield* afterCreate(
          "joining the active sprint",
          joinActiveSprint(key, p.projectKey, proposalId),
        );
        if (joined?.sprint) message += ` in sprint ${joined.sprint}`;
        if (joined?.warning) warnings.push(joined.warning);
      }
      return {
        message,
        issueKey: key,
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      } satisfies ProposalResult;
    });

  /**
   * Moves a new issue into the active sprint holding most of the user's open
   * work, preferring a board that shows its project (D44). Chosen now, from the
   * synced sprint state, so a proposal approved days later lands in today's sprint.
   */
  const joinActiveSprint = (issueKey: string, projectKey: string, proposalId: string) =>
    Effect.gen(function* () {
      const me = yield* withDb(getState(SYNC_KEYS.username));
      const state = parseSprintState(yield* withDb(getState(SYNC_KEYS.sprints)));
      const mine = me
        ? yield* q((d) =>
            d
              .select({
                assignee: jiraIssues.assignee,
                sprint: jiraIssues.sprint,
                statusCategory: jiraIssues.statusCategory,
              })
              .from(jiraIssues)
              .where(and(eq(jiraIssues.assignee, me), eq(jiraIssues.stale, false)))
              .all(),
          )
        : [];
      const sprint = userActiveSprints(state.sprints, mine, me ?? null, {
        preferProject: projectKey,
        boardProjects: state.boardProjects,
      })[0];
      if (!sprint)
        return {
          sprint: null,
          warning: `No active sprint holds your work, so ${issueKey} stays in the backlog.`,
        };
      return yield* run(
        { kind: "move_to_sprint", issueKey, sprintId: sprint.id, sprintName: sprint.name },
        { proposalId },
      ).pipe(
        Effect.as({ sprint: sprint.name, warning: null as string | null }),
        Effect.catchAll((e) =>
          Effect.succeed({
            sprint: null,
            warning: `${issueKey} was created but could not be moved into sprint ${sprint.name}: ${e.message}`,
          }),
        ),
      );
    });

  /** The target's "blocks" links, read from Jira (not the cache) for the direction check. */
  const blockLinksOf = (key: string) =>
    Effect.map(jira.getIssue(key, { fields: ["issuelinks"] }), (raw) =>
      blockLinks(parseIssueLinks(raw.fields.issuelinks)),
    );

  /**
   * "target is blocked by blocker" (D45). Link direction in Jira's API is easy to
   * get backwards and some instances store it reversed, so after the POST the
   * target is read again; a link that came out the wrong way round is deleted and
   * posted swapped. Only a link this POST made is ever deleted, never one the
   * user already had; a target that already blocks the blocker is refused, since
   * the two would block each other and neither could ever wake.
   */
  const linkIssues = (p: Extract<ProposalPayload, { kind: "link_issues" }>, proposalId: string) =>
    Effect.gen(function* () {
      const { blocks } = parseLinkTypes(yield* withDb(getState(SYNC_KEYS.linkTypes)));
      if (!blocks)
        return yield* fail(
          "unsupported",
          'Jira has no "blocks" link type the app knows of. Sync again, or link the issues in Jira.',
        );
      const message = `${p.target} is now blocked by ${p.blocker}`;
      const isRight = (links: readonly BlockLink[]) =>
        links.some((l) => l.direction === "blockedBy" && l.key === p.blocker);
      const blocksBlocker = (links: readonly BlockLink[]) =>
        links.filter((l) => l.direction === "blocks" && l.key === p.blocker);
      const before = yield* blockLinksOf(p.target);
      if (isRight(before)) {
        yield* audit(proposalId, "link_issues", p.target, p, { skipped: "already linked" });
        return {
          message: `${p.target} is already blocked by ${p.blocker}`,
          issueKey: p.target,
          undo: { kind: "link_issues", issueKey: p.target, linkId: null },
        } satisfies ProposalResult;
      }
      if (blocksBlocker(before).length > 0)
        return yield* fail(
          "invalid",
          `${p.target} already blocks ${p.blocker} in Jira, so it cannot also wait for it: the two would block each other. Remove that link in Jira first if it is wrong.`,
        );
      const existing = new Set(before.flatMap((l) => (l.id ? [l.id] : [])));
      // The link this approval made, for revoking it (D54): one between the two
      // issues that was not there before.
      const undo = (links: readonly BlockLink[]): Undo => ({
        kind: "link_issues",
        issueKey: p.target,
        linkId:
          links.find(
            (l) =>
              l.key === p.blocker && l.direction === "blockedBy" && l.id && !existing.has(l.id),
          )?.id ??
          links.find((l) => l.key === p.blocker && l.id && !existing.has(l.id))?.id ??
          null,
      });
      const link = (swapped: boolean) =>
        run(
          {
            kind: "link_issues",
            issueKey: p.target,
            blockerKey: p.blocker,
            linkType: blocks.name,
            swapped,
          },
          { proposalId },
        );
      yield* link(false);
      const after = yield* blockLinksOf(p.target);
      if (isRight(after))
        return { message, issueKey: p.target, undo: undo(after) } satisfies ProposalResult;
      // Only a link that was not there before this POST is ours to replace.
      const wrong = blocksBlocker(after).find((l) => l.id && !existing.has(l.id));
      if (!wrong?.id)
        return {
          message: `Linked ${p.target} and ${p.blocker}`,
          issueKey: p.target,
          warning: `Jira does not show ${p.target} as blocked by ${p.blocker} after linking them; check the link in Jira.`,
          undo: undo(after),
        } satisfies ProposalResult;
      // The instance stored it the other way round: replace it with the swapped form.
      logger.warn(`${p.target} came out blocking ${p.blocker}; linking it the other way`);
      yield* run(
        { kind: "delete_issue_link", issueKey: p.target, linkId: wrong.id },
        { proposalId },
      );
      // The delete went through, so a failure here leaves the issues unlinked.
      yield* link(true).pipe(
        Effect.mapError((e) =>
          e instanceof JiraError
            ? new JiraError({
                kind: e.kind,
                status: e.status,
                message: `${p.target} and ${p.blocker} are not linked now: Jira stored the link the wrong way round, so it was removed, and linking them the right way failed (${e.message}). Retry links them again.`,
              })
            : e,
        ),
      );
      const final = yield* blockLinksOf(p.target);
      if (isRight(final))
        return { message, issueKey: p.target, undo: undo(final) } satisfies ProposalResult;
      return {
        message: `Linked ${p.target} and ${p.blocker}`,
        issueKey: p.target,
        warning: `Jira still does not show ${p.target} as blocked by ${p.blocker}; check the link in Jira.`,
        undo: undo(final),
      } satisfies ProposalResult;
    });

  const transition = (
    p: Extract<ProposalPayload, { kind: "transition_issue" }>,
    proposalId: string,
  ) =>
    Effect.gen(function* () {
      const available = yield* jira.getTransitions(p.target);
      const wanted = p.toStatus.toLowerCase();
      const t =
        available.find((x) => x.to.name.toLowerCase() === wanted) ??
        available.find((x) => x.name.toLowerCase() === wanted);
      if (!t) {
        return yield* fail(
          "unsupported",
          `${p.target} cannot move to ${p.toStatus} from its current status (available: ${available.map((x) => x.to.name).join(", ") || "none"}).`,
        );
      }
      // The status it leaves, for revoking the move (D54).
      const from = issueStatus((yield* jira.getIssue(p.target, { fields: ["status"] })).fields);
      yield* run(
        { kind: "transition", issueKey: p.target, transitionId: t.id, transitionName: t.to.name },
        { proposalId },
      );
      return {
        message: `Moved ${p.target} to ${t.to.name}`,
        issueKey: p.target,
        ...(from
          ? {
              undo: {
                kind: "transition_issue",
                issueKey: p.target,
                fromStatus: from.name,
                toStatus: t.to.name,
              },
            }
          : {}),
      } satisfies ProposalResult;
    });

  /** Idempotent: an issue the cache already shows in the sprint needs no write. */
  const moveToSprint = (
    p: Extract<ProposalPayload, { kind: "move_to_sprint" }>,
    proposalId: string,
  ) =>
    Effect.gen(function* () {
      const cached = yield* q((d) =>
        d
          .select({ sprint: jiraIssues.sprint })
          .from(jiraIssues)
          .where(eq(jiraIssues.key, p.target))
          .get(),
      );
      const message = `Moved ${p.target} to sprint ${p.sprintName}`;
      if (cached?.sprint === p.sprintName) {
        yield* audit(
          proposalId,
          "move_to_sprint",
          p.target,
          { sprintId: p.sprintId, sprintName: p.sprintName },
          { skipped: "already in sprint" },
        );
        return {
          message: `${p.target} is already in sprint ${p.sprintName}`,
          issueKey: p.target,
          undo: { kind: "move_to_sprint", issueKey: p.target, moved: false, sprintId: p.sprintId },
        } satisfies ProposalResult;
      }
      // The open sprint it leaves (null: the backlog), for revoking the move (D54).
      const sprintField = (yield* sync.fieldInfo).effective.sprint;
      const previous = sprintField
        ? openSprint(
            (yield* jira.getIssue(p.target, { fields: [sprintField] })).fields[sprintField],
          )
        : undefined;
      yield* run(
        {
          kind: "move_to_sprint",
          issueKey: p.target,
          sprintId: p.sprintId,
          sprintName: p.sprintName,
        },
        { proposalId },
      );
      return {
        message,
        issueKey: p.target,
        undo: {
          kind: "move_to_sprint",
          issueKey: p.target,
          moved: previous?.id !== p.sprintId,
          sprintId: p.sprintId,
          ...(previous === undefined ? {} : { previous }),
        },
      } satisfies ProposalResult;
    });

  /**
   * A change to an open dependency from intake (D46), through the functions the
   * Waiting page uses: the new date, the timeline entry (which schedules the next
   * chase) and the resolution, then the remote link of a mirrored dependency. The
   * local change stands once made, so a failed link update is a warning.
   */
  const updateWait = (p: PayloadOf<"update_dependency">, proposalId: string) =>
    Effect.gen(function* () {
      const dep = yield* q((d) =>
        d.select().from(dependencies).where(eq(dependencies.id, p.dependencyId)).get(),
      );
      if (!dep) return yield* fail("invalid", "That dependency no longer exists.");
      const what = `${dep.issueKey} waits on ${dep.label}`;
      const ids = { dependencyId: dep.id, issueKey: dep.issueKey };
      // A retry keeps the state the first attempt found, before it changed anything.
      const prior = yield* priorUndo(proposalId, "update_dependency");
      if (dep.status === "resolved" && prior?.before)
        return {
          message: `${what} was already resolved`,
          ...ids,
          undo: { ...prior, after: waitState(dep) },
        } satisfies ProposalResult;
      if (dep.status === "resolved") {
        if (p.action !== "resolve")
          return yield* fail(
            "invalid",
            `${what} is resolved; reopen it on the Waiting page first.`,
          );
        yield* audit(proposalId, "update_dependency", dep.id, p, { skipped: "already resolved" });
        return {
          message: `${what} was already resolved`,
          ...ids,
          undo: {
            kind: "update_dependency",
            dependencyId: dep.id,
            before: null,
            after: null,
            followupId: null,
          },
        } satisfies ProposalResult;
      }
      const before = prior?.before ?? waitState(dep);
      yield* keepUndo(proposalId, {
        kind: "update_dependency",
        dependencyId: dep.id,
        before,
        after: null,
        followupId: null,
      });
      if (p.action !== "resolve" && p.expectedAt && p.expectedAt !== dep.expectedAt)
        yield* local(setDates(dep.id, { expectedAt: p.expectedAt }, { mirror: false }));
      const summary = (
        p.summary ?? describeWaitUpdate({ ...p, issueKey: dep.issueKey, label: dep.label })
      ).trim();
      const nextFollowupAt = p.action === "resolve" ? null : nextFollowupAfter(p);
      // These steps share no transaction, so a retry after a later step failed
      // finds the entry this proposal already wrote (same text, written since the
      // proposal was made) and only sets the dates again, not a second entry.
      const since = (yield* q((d) =>
        d
          .select({ at: proposals.createdAt })
          .from(proposals)
          .where(eq(proposals.id, proposalId))
          .get(),
      ))?.at;
      const written = since
        ? yield* q((d) =>
            d
              .select({ id: followups.id })
              .from(followups)
              .where(
                and(
                  eq(followups.dependencyId, dep.id),
                  eq(followups.summary, summary),
                  p.channel ? eq(followups.channel, p.channel) : isNull(followups.channel),
                  gte(followups.at, since),
                ),
              )
              .get(),
          )
        : undefined;
      let followupId: string;
      if (written) {
        followupId = written.id;
        const days = (yield* settingsOrDefault(settings)).dependencies.followupDays;
        yield* local(
          setDates(
            dep.id,
            {
              nextFollowupAt:
                nextFollowupAt === undefined ? addBusinessDays(localDate(), days) : nextFollowupAt,
            },
            { mirror: false },
          ),
        );
      } else
        followupId = yield* local(
          logFollowup(dep.id, { channel: p.channel, summary, nextFollowupAt }),
        );
      if (p.action === "resolve") yield* local(setStatus(dep.id, "resolved", { mirror: false }));
      const warning = yield* local(mirror(dep.id, "refresh", { proposalId })).pipe(
        Effect.as(null),
        Effect.catchAll((e) =>
          Effect.succeed(
            `The wait was updated here, but its link on ${dep.issueKey} in Jira was not: ${e.message}`,
          ),
        ),
      );
      yield* audit(proposalId, "update_dependency", dep.id, p, { followupId });
      const now = yield* q((d) =>
        d.select().from(dependencies).where(eq(dependencies.id, dep.id)).get(),
      );
      const undo: Undo = {
        kind: "update_dependency",
        dependencyId: dep.id,
        before,
        after: now ? waitState(now) : null,
        followupId,
      };
      const message =
        p.action === "resolve"
          ? `Resolved: ${what}`
          : p.action === "log_reply"
            ? `Logged the reply on ${what}`
            : `Rescheduled ${what}`;
      return {
        message,
        ...ids,
        ...(warning ? { warning } : {}),
        undo,
      } satisfies ProposalResult;
    });

  const runProposal = (
    payload: ProposalPayload,
    opts: { proposalId: string; inboxItemId: string | null },
  ) =>
    Effect.gen(function* () {
      const unresolved = issueRefs(payload, { only: "new" });
      if (unresolved.length) {
        return yield* fail(
          "invalid",
          `Approve the new issue ${unresolved.join(", ")} first; this proposal depends on it.`,
        );
      }
      const { proposalId } = opts;

      switch (payload.kind) {
        case "create_issue":
          return yield* createIssue(payload, proposalId);
        case "add_comment": {
          const safe = proposalTextToWiki(payload.bodyMd, yield* knownJiraUsers(payload.target));
          const { response } = yield* run(
            {
              kind: "add_comment",
              issueKey: payload.target,
              bodyMarkdown: payload.bodyMd,
              bodyWiki: safe.wiki,
            },
            { proposalId },
          );
          // The new comment's id, for revoking it (D54).
          const commentId = (response as { id?: unknown } | null)?.id;
          const warning = wikiSafetyWarning(safe, "comment");
          return {
            message: `Commented on ${payload.target}`,
            issueKey: payload.target,
            ...(warning ? { warning } : {}),
            ...(typeof commentId === "string" || typeof commentId === "number"
              ? {
                  undo: {
                    kind: "add_comment",
                    issueKey: payload.target,
                    commentId: String(commentId),
                  },
                }
              : {}),
          } satisfies ProposalResult;
        }
        case "transition_issue":
          return yield* transition(payload, proposalId);
        case "move_to_sprint":
          return yield* moveToSprint(payload, proposalId);
        case "update_issue": {
          const { assignee, ...fields } = payload.changes;
          // The values it replaces, read just before, for revoking it (D54).
          const keys = Object.keys(payload.changes) as IssueField[];
          const current = yield* jira.getIssue(payload.target, {
            fields: keys.map((k) => ISSUE_FIELD_IDS[k]),
          });
          // A retry keeps the values the first attempt replaced: the earliest per field.
          const prior = yield* priorUndo(proposalId, "update_issue");
          const before: IssueFieldValues = {
            ...issueFieldValues(current.fields, keys),
            ...Object.fromEntries(
              keys.filter((k) => prior && k in prior.before).map((k) => [k, prior?.before[k]]),
            ),
          };
          const after: IssueFieldValues = { ...payload.changes };
          const names = { ...issueUserNames(current.fields, keys), ...prior?.names };
          const undo: Undo = {
            kind: "update_issue",
            issueKey: payload.target,
            before,
            after,
            ...(Object.keys(names).length ? { names } : {}),
          };
          yield* keepUndo(proposalId, undo);
          if (Object.keys(fields).length > 0) {
            yield* run({ kind: "update_fields", issueKey: payload.target, fields }, { proposalId });
          }
          if (assignee !== undefined) {
            yield* run(
              { kind: "assign", issueKey: payload.target, username: assignee },
              { proposalId },
            );
          }
          return {
            message: `Updated ${payload.target}`,
            issueKey: payload.target,
            undo,
          } satisfies ProposalResult;
        }
        case "link_dependency": {
          const id = newId();
          const row = {
            id,
            issueKey: payload.target,
            kind: payload.dependencyKind,
            label: payload.label,
            ownerPersonId: payload.ownerPersonId,
            ownerTeamId: payload.ownerTeamId,
            externalRef: payload.externalRef,
            externalUrl: payload.externalUrl,
            status: "open" as const,
            requestedAt: nowIso(),
            expectedAt: payload.expectedAt,
            nextFollowupAt: payload.nextFollowupAt,
          };
          yield* q((d) => d.insert(dependencies).values(row));
          yield* audit(proposalId, "link_dependency", payload.target, row, { id });
          return {
            message: `${payload.target} now waits on ${payload.label}`,
            dependencyId: id,
            issueKey: payload.target,
          } satisfies ProposalResult;
        }
        case "link_issues":
          return yield* linkIssues(payload, proposalId);
        case "update_dependency":
          return yield* updateWait(payload, proposalId);
        case "update_person": {
          const person = yield* q((d) =>
            d.select().from(people).where(eq(people.id, payload.personId)).get(),
          );
          if (!person) return yield* fail("invalid", "That contact no longer exists.");
          const { profile, ...rest } = payload.changes;
          const set = {
            ...rest,
            profile: { ...(person.profile ?? {}), ...(profile ?? {}) },
            notesMd: appendNote(person.notesMd, payload.noteAppend),
          };
          yield* q((d) => d.update(people).set(set).where(eq(people.id, person.id)));
          yield* audit(proposalId, "update_person", person.id, set, null);
          return {
            message: `Updated ${person.displayName}`,
            undo: { kind: "update_person", personId: person.id, ...changedColumns(person, set) },
          } satisfies ProposalResult;
        }
        case "update_team": {
          const team = yield* q((d) =>
            d.select().from(teams).where(eq(teams.id, payload.teamId)).get(),
          );
          if (!team) return yield* fail("invalid", "That team no longer exists.");
          const set = { ...payload.changes, notesMd: appendNote(team.notesMd, payload.noteAppend) };
          yield* q((d) => d.update(teams).set(set).where(eq(teams.id, team.id)));
          yield* audit(proposalId, "update_team", team.id, set, null);
          return {
            message: `Updated ${team.name}`,
            undo: { kind: "update_team", teamId: team.id, ...changedColumns(team, set) },
          } satisfies ProposalResult;
        }
        case "remember": {
          const id = newId();
          const row = {
            id,
            kind: payload.memoryKind,
            subjectType: payload.subjectType,
            subjectId: payload.subjectId,
            content: payload.content,
            source: "inferred" as const,
            sourceInboxItemId: opts.inboxItemId,
            // Approval is the confirmation (FR-7.5).
            confirmed: true,
            createdAt: nowIso(),
          };
          yield* q((d) => d.insert(memories).values(row));
          yield* audit(proposalId, "remember", id, row, null);
          return { message: "Remembered", memoryId: id } satisfies ProposalResult;
        }
        case "draft_message": {
          const id = newId();
          // The notes become a draft request; the Drafts page writes the message (D24).
          const row = {
            id,
            kind: payload.channel,
            intent: payload.intent,
            recipientPersonId: payload.recipientPersonId,
            recipientTeamId: payload.recipientTeamId,
            issueKeys: payload.issueKeys,
            notesMd: payload.notes,
            bodyMd: "",
            status: "draft" as const,
            createdAt: nowIso(),
          };
          yield* q((d) => d.insert(communications).values(row));
          yield* audit(proposalId, "draft_message", id, row, null);
          return {
            message: "Saved to Drafts",
            communicationId: id,
          } satisfies ProposalResult;
        }
        case "needs_clarification":
          return yield* fail("unsupported", "Answer the question instead of approving it.");
      }
    });

  /** The Waiting page's functions read the Executor, the settings and the database. */
  const local = <A, E>(e: Effect.Effect<A, E, Executor | Settings | Db>) =>
    e.pipe(
      Effect.provideService(Executor, self),
      Effect.provideService(Settings, settings),
      Effect.provideService(Db, db),
    );

  /** One write that revokes an approval (D54 (3)); a warning when it ran but part did not. */
  const reverse = (op: ReverseOp, opts: { proposalId: string }) =>
    Effect.gen(function* () {
      const { proposalId } = opts;
      switch (op.kind) {
        case "jira":
          yield* run(op.action, { proposalId });
          return {};
        case "transition_to": {
          // Chosen now, from the issue's status now: an earlier step may have moved it.
          const now = issueStatus(
            (yield* jira.getIssue(op.issueKey, { fields: ["status"] })).fields,
          );
          if (now && now.name.toLowerCase() === op.status.toLowerCase()) return {};
          const available = yield* jira.getTransitions(op.issueKey);
          const t = available.find((x) => x.to.name.toLowerCase() === op.status.toLowerCase());
          if (!t)
            return yield* fail(
              "invalid",
              `${op.issueKey} cannot move to ${op.status} from ${now?.name ?? "its status"} (available: ${available.map((x) => x.to.name).join(", ") || "none"}).`,
            );
          yield* run(
            {
              kind: "transition",
              issueKey: op.issueKey,
              transitionId: t.id,
              transitionName: t.to.name,
            },
            { proposalId },
          );
          return {};
        }
        case "delete_wait":
          yield* local(deleteDependency(op.dependencyId, { proposalId }));
          yield* audit(proposalId, "revoke_wait", op.dependencyId, op, null);
          return {};
        case "restore_wait": {
          const state = op.state;
          if (state)
            yield* q((d) =>
              d.update(dependencies).set(state).where(eq(dependencies.id, op.dependencyId)),
            );
          if (op.followupId) {
            const followupId = op.followupId;
            yield* q((d) => d.delete(followups).where(eq(followups.id, followupId)));
          }
          yield* audit(proposalId, "revoke_wait_update", op.dependencyId, op, null);
          const warning = yield* local(mirror(op.dependencyId, "refresh", { proposalId })).pipe(
            Effect.as(undefined),
            Effect.catchAll((e) =>
              Effect.succeed(
                `The wait was put back here, but its link in Jira was not updated: ${e.message}`,
              ),
            ),
          );
          return warning ? { warning } : {};
        }
        case "restore_person": {
          const set = pickColumns(op.set, PERSON_COLUMNS);
          if (Object.keys(set).length)
            yield* q((d) => d.update(people).set(set).where(eq(people.id, op.personId)));
          yield* audit(proposalId, "revoke_person", op.personId, set, null);
          return {};
        }
        case "restore_team": {
          const set = pickColumns(op.set, TEAM_COLUMNS);
          if (Object.keys(set).length)
            yield* q((d) => d.update(teams).set(set).where(eq(teams.id, op.teamId)));
          yield* audit(proposalId, "revoke_team", op.teamId, set, null);
          return {};
        }
        case "delete_memory":
          yield* q((d) => d.delete(memories).where(eq(memories.id, op.memoryId)));
          yield* audit(proposalId, "revoke_memory", op.memoryId, op, null);
          return {};
        case "forget_issue":
          yield* forgetIssue(op.issueKey, proposalId);
          yield* audit(proposalId, "forget_issue", op.issueKey, op, null);
          return {};
        case "delete_draft": {
          // Only a draft: a message that was sent or copied cannot be taken back.
          const gone = yield* q((d) =>
            d
              .delete(communications)
              .where(
                and(eq(communications.id, op.communicationId), eq(communications.status, "draft")),
              )
              .returning({ id: communications.id }),
          );
          if (gone.length === 0) {
            const still = yield* q((d) =>
              d
                .select({ status: communications.status })
                .from(communications)
                .where(eq(communications.id, op.communicationId))
                .get(),
            );
            if (still) return yield* fail("invalid", `The draft was ${still.status}, so it stays.`);
          }
          yield* audit(proposalId, "revoke_draft", op.communicationId, op, null);
          return {};
        }
      }
    });

  const self: ExecutorShape = Executor.of({
    runProposal,
    run: (input, opts = {}) => run(input, opts),
    reverse,
  });
  return self;
});

export const ExecutorLive = Layer.effect(Executor, make);

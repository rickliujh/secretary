import { and, eq, isNotNull } from "drizzle-orm";
import { Cause, Effect, Layer } from "effect";
import {
  actionsLog,
  communications,
  dependencies,
  issueMeta,
  jiraIssues,
  memories,
  people,
  teams,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redactValue } from "@/lib/redact";
import { wikiSafetyWarning } from "@/lib/wiki-safe";
import { parseLinkTypes } from "@/services/blockers/logic";
import { type BlockLink, blockLinks } from "@/services/dashboard/sections";
import { bindDb, Db } from "@/services/db";
import { nextFollowupAfter } from "@/services/dependencies/logic";
import { logFollowup, mirror, setDates, setStatus } from "@/services/dependencies/queries";
import { CreatedIssueSchema, JiraClient, JiraError } from "@/services/jira";
import { parseIssueLinks } from "@/services/jira/schemas";
import {
  describeWaitUpdate,
  issueRefs,
  type PayloadOf,
  type ProposalPayload,
} from "@/services/proposals/schema";
import { Settings } from "@/services/settings";
import { userActiveSprints } from "@/services/sprints/active";
import { Sync } from "@/services/sync";
import { getState, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import {
  describeAction,
  Executor,
  ExecutorError,
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

      // Show Jira's truth after every write (design.md 7.3). Remote links are
      // not part of the cached issue, so those writes need no re-fetch.
      const touchesIssue =
        action.kind !== "upsert_remote_link" && action.kind !== "delete_remote_link";
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
        } satisfies ProposalResult;
      }
      if (blocksBlocker(before).length > 0)
        return yield* fail(
          "invalid",
          `${p.target} already blocks ${p.blocker} in Jira, so it cannot also wait for it: the two would block each other. Remove that link in Jira first if it is wrong.`,
        );
      const existing = new Set(before.flatMap((l) => (l.id ? [l.id] : [])));
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
      if (isRight(after)) return { message, issueKey: p.target } satisfies ProposalResult;
      // Only a link that was not there before this POST is ours to replace.
      const wrong = blocksBlocker(after).find((l) => l.id && !existing.has(l.id));
      if (!wrong?.id)
        return {
          message: `Linked ${p.target} and ${p.blocker}`,
          issueKey: p.target,
          warning: `Jira does not show ${p.target} as blocked by ${p.blocker} after linking them; check the link in Jira.`,
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
      if (isRight(yield* blockLinksOf(p.target)))
        return { message, issueKey: p.target } satisfies ProposalResult;
      return {
        message: `Linked ${p.target} and ${p.blocker}`,
        issueKey: p.target,
        warning: `Jira still does not show ${p.target} as blocked by ${p.blocker}; check the link in Jira.`,
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
      yield* run(
        { kind: "transition", issueKey: p.target, transitionId: t.id, transitionName: t.to.name },
        { proposalId },
      );
      return {
        message: `Moved ${p.target} to ${t.to.name}`,
        issueKey: p.target,
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
        } satisfies ProposalResult;
      }
      yield* run(
        {
          kind: "move_to_sprint",
          issueKey: p.target,
          sprintId: p.sprintId,
          sprintName: p.sprintName,
        },
        { proposalId },
      );
      return { message, issueKey: p.target } satisfies ProposalResult;
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
      if (dep.status === "resolved") {
        if (p.action !== "resolve")
          return yield* fail(
            "invalid",
            `${what} is resolved; reopen it on the Waiting page first.`,
          );
        yield* audit(proposalId, "update_dependency", dep.id, p, { skipped: "already resolved" });
        return { message: `${what} was already resolved`, ...ids } satisfies ProposalResult;
      }
      // The Waiting page's functions read the Executor (for the remote link), the
      // settings (the chase interval) and the database from their context.
      const local = <A, E>(e: Effect.Effect<A, E, Executor | Settings | Db>) =>
        e.pipe(
          Effect.provideService(Executor, self),
          Effect.provideService(Settings, settings),
          Effect.provideService(Db, db),
        );
      if (p.action !== "resolve" && p.expectedAt && p.expectedAt !== dep.expectedAt)
        yield* local(setDates(dep.id, { expectedAt: p.expectedAt }, { mirror: false }));
      const followupId = yield* local(
        logFollowup(dep.id, {
          channel: p.channel,
          summary:
            p.summary ?? describeWaitUpdate({ ...p, issueKey: dep.issueKey, label: dep.label }),
          nextFollowupAt: p.action === "resolve" ? null : nextFollowupAfter(p),
        }),
      );
      if (p.action === "resolve") yield* local(setStatus(dep.id, "resolved", { mirror: false }));
      const warning = yield* local(mirror(dep.id, "refresh")).pipe(
        Effect.as(null),
        Effect.catchAll((e) =>
          Effect.succeed(
            `The wait was updated here, but its link on ${dep.issueKey} in Jira was not: ${e.message}`,
          ),
        ),
      );
      yield* audit(proposalId, "update_dependency", dep.id, p, { followupId });
      const message =
        p.action === "resolve"
          ? `Resolved: ${what}`
          : p.action === "log_reply"
            ? `Logged the reply on ${what}`
            : `Rescheduled ${what}`;
      return { message, ...ids, ...(warning ? { warning } : {}) } satisfies ProposalResult;
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
      const jiraAction = (action: JiraAction, message: string) =>
        Effect.as(run(action, { proposalId }), {
          message,
          issueKey: action.issueKey,
        } satisfies ProposalResult);

      switch (payload.kind) {
        case "create_issue":
          return yield* createIssue(payload, proposalId);
        case "add_comment": {
          const safe = proposalTextToWiki(payload.bodyMd, yield* knownJiraUsers(payload.target));
          const result = yield* jiraAction(
            {
              kind: "add_comment",
              issueKey: payload.target,
              bodyMarkdown: payload.bodyMd,
              bodyWiki: safe.wiki,
            },
            `Commented on ${payload.target}`,
          );
          const warning = wikiSafetyWarning(safe, "comment");
          return warning ? { ...result, warning } : result;
        }
        case "transition_issue":
          return yield* transition(payload, proposalId);
        case "move_to_sprint":
          return yield* moveToSprint(payload, proposalId);
        case "update_issue": {
          const { assignee, ...fields } = payload.changes;
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
          return { message: `Updated ${person.displayName}` } satisfies ProposalResult;
        }
        case "update_team": {
          const team = yield* q((d) =>
            d.select().from(teams).where(eq(teams.id, payload.teamId)).get(),
          );
          if (!team) return yield* fail("invalid", "That team no longer exists.");
          const set = { ...payload.changes, notesMd: appendNote(team.notesMd, payload.noteAppend) };
          yield* q((d) => d.update(teams).set(set).where(eq(teams.id, team.id)));
          yield* audit(proposalId, "update_team", team.id, set, null);
          return { message: `Updated ${team.name}` } satisfies ProposalResult;
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

  const self = Executor.of({
    runProposal,
    run: (input, opts = {}) => run(input, opts),
  });
  return self;
});

export const ExecutorLive = Layer.effect(Executor, make);

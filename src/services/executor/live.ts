import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  actionsLog,
  communications,
  dependencies,
  jiraIssues,
  memories,
  people,
  teams,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redactValue } from "@/lib/redact";
import { bindDb, Db } from "@/services/db";
import { CreatedIssueSchema, JiraClient } from "@/services/jira";
import { issueRefs, type ProposalPayload } from "@/services/proposals/schema";
import { Sync } from "@/services/sync";
import {
  describeAction,
  Executor,
  ExecutorError,
  type JiraAction,
  JiraActionSchema,
  type ProposalResult,
} from ".";
import { buildCreateIssue, buildJiraWrite, MappingError } from "./jira-mapping";

const make = Effect.gen(function* () {
  const jira = yield* JiraClient;
  const sync = yield* Sync;
  const { q } = bindDb(yield* Db);

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
      const plan = yield* Effect.try({
        try: () =>
          buildCreateIssue(
            {
              projectKey: p.projectKey,
              issueTypeId: type.id,
              issueTypeName: type.name,
              summary: p.summary,
              descriptionMd: p.descriptionMd,
              parent: p.parent,
              epic: p.epic,
              priority: p.priority,
              assignee: p.assignee,
              dueDate: p.dueDate,
            },
            { deployment, fieldIds, fields },
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
      yield* log({
        proposalId,
        action: "create_issue",
        target: key,
        request: plan.request,
        response,
        ok: true,
      });
      yield* sync.refreshIssue(key).pipe(Effect.ignore);
      if (plan.epicAfterCreate)
        yield* run(
          { kind: "set_epic", issueKey: key, epicKey: plan.epicAfterCreate },
          { proposalId },
        );
      return { message: `Created ${key}`, issueKey: key } satisfies ProposalResult;
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
        case "add_comment":
          return yield* jiraAction(
            { kind: "add_comment", issueKey: payload.target, bodyMarkdown: payload.bodyMd },
            `Commented on ${payload.target}`,
          );
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

  return Executor.of({
    runProposal,
    run: (input, opts = {}) => run(input, opts),
  });
});

export const ExecutorLive = Layer.effect(Executor, make);

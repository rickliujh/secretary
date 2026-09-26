/**
 * Dependencies and follow-ups (FR-3). Local writes are the user's own actions;
 * mirroring to Jira goes through the Executor.
 */
import { and, asc, desc, eq, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { communications, dependencies, followups, jiraIssues, people, teams } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { Executor, ExecutorError } from "@/services/executor";
import { Settings } from "@/services/settings";
import {
  addBusinessDays,
  chaseNotes,
  type DependencyStatus,
  mirrorGlobalId,
  mirrorUrl,
  type OwnerRef,
} from "./logic";
import {
  type DependencyInput,
  DependencyInputSchema,
  type FollowupInput,
  FollowupInputSchema,
} from "./schema";

export type Dependency = typeof dependencies.$inferSelect;

export type DependencyRow = Dependency & {
  issueSummary: string | null;
  issueStatus: string | null;
  owner: OwnerRef;
  lastFollowupAt: string | null;
  followupCount: number;
};

const ownerOf = (
  d: { ownerPersonId: string | null; ownerTeamId: string | null; label: string },
  names: {
    person: Map<string, string>;
    team: Map<string, string>;
  },
): OwnerRef =>
  d.ownerPersonId && names.person.has(d.ownerPersonId)
    ? { type: "person", id: d.ownerPersonId, name: names.person.get(d.ownerPersonId) ?? "" }
    : d.ownerTeamId && names.team.has(d.ownerTeamId)
      ? { type: "team", id: d.ownerTeamId, name: names.team.get(d.ownerTeamId) ?? "" }
      : { type: "none", id: null, name: "No owner" };

/** Dependencies with issue, owner and follow-up context. */
export const listDependencies = (opts: { includeResolved?: boolean; issueKey?: string } = {}) =>
  Effect.gen(function* () {
    const rows = yield* query((d) =>
      d
        .select()
        .from(dependencies)
        .where(
          and(
            opts.includeResolved ? undefined : ne(dependencies.status, "resolved"),
            opts.issueKey ? eq(dependencies.issueKey, opts.issueKey) : undefined,
          ),
        )
        .all(),
    );
    if (rows.length === 0) return [] as DependencyRow[];
    const keys = [...new Set(rows.map((r) => r.issueKey))];
    const issues = new Map(
      (yield* query((d) =>
        d
          .select({ key: jiraIssues.key, summary: jiraIssues.summary, status: jiraIssues.status })
          .from(jiraIssues)
          .where(inArray(jiraIssues.key, keys))
          .all(),
      )).map((i) => [i.key, i]),
    );
    const names = {
      person: new Map(
        (yield* query((d) =>
          d.select({ id: people.id, n: people.displayName }).from(people).all(),
        )).map((p) => [p.id, p.n]),
      ),
      team: new Map(
        (yield* query((d) => d.select({ id: teams.id, n: teams.name }).from(teams).all())).map(
          (t) => [t.id, t.n],
        ),
      ),
    };
    const stats = new Map(
      (yield* query((d) =>
        d
          .select({
            id: followups.dependencyId,
            last: sql<string>`max(${followups.at})`,
            n: sql<number>`count(*)`,
          })
          .from(followups)
          .where(
            inArray(
              followups.dependencyId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(followups.dependencyId)
          .all(),
      )).map((s) => [s.id, s]),
    );
    return rows.map(
      (r): DependencyRow => ({
        ...r,
        issueSummary: issues.get(r.issueKey)?.summary ?? null,
        issueStatus: issues.get(r.issueKey)?.status ?? null,
        owner: ownerOf(r, names),
        lastFollowupAt: stats.get(r.id)?.last ?? null,
        followupCount: Number(stats.get(r.id)?.n ?? 0),
      }),
    );
  });

export const getDependency = (id: string) =>
  Effect.gen(function* () {
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!dep) return null;
    const timeline = yield* query((d) =>
      d
        .select()
        .from(followups)
        .where(eq(followups.dependencyId, id))
        .orderBy(desc(followups.at))
        .all(),
    );
    return { dependency: dep, timeline };
  });

const notFound = () =>
  new ExecutorError({ kind: "invalid", message: "That dependency no longer exists." });

/**
 * Pushes the current state of a mirrored dependency to its Jira remote link.
 * Does nothing for dependencies that are not mirrored.
 */
export const refreshMirror = (id: string) =>
  Effect.gen(function* () {
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!dep?.mirrorRemoteLinkId) return;
    yield* mirror(id, true);
  });

/** Turns Jira mirroring on or off for one dependency (FR-3.4). */
export const mirror = (id: string, on: boolean) =>
  Effect.gen(function* () {
    const executor = yield* Executor;
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!dep) return yield* notFound();
    if (!on) {
      if (dep.mirrorRemoteLinkId) {
        yield* executor.run({
          kind: "delete_remote_link",
          issueKey: dep.issueKey,
          globalId: mirrorGlobalId(dep.id),
        });
      }
      yield* query((d) =>
        d.update(dependencies).set({ mirrorRemoteLinkId: null }).where(eq(dependencies.id, id)),
      );
      return null;
    }
    const team = dep.ownerTeamId
      ? yield* query((d) =>
          d
            .select()
            .from(teams)
            .where(eq(teams.id, dep.ownerTeamId ?? ""))
            .get(),
        )
      : undefined;
    const person = dep.ownerPersonId
      ? yield* query((d) =>
          d
            .select()
            .from(people)
            .where(eq(people.id, dep.ownerPersonId ?? ""))
            .get(),
        )
      : undefined;
    const url = mirrorUrl(dep, { teamUrls: team?.confluenceUrls, personEmail: person?.email });
    if (!url) {
      return yield* new ExecutorError({
        kind: "unsupported",
        message:
          "Jira needs a link for a mirrored dependency. Add a URL, or an owner with a Confluence page or email.",
      });
    }
    const owner = person?.displayName ?? team?.name;
    const result = yield* executor.run({
      kind: "upsert_remote_link",
      issueKey: dep.issueKey,
      globalId: mirrorGlobalId(dep.id),
      url,
      title: `Waiting on ${dep.label}${dep.externalRef ? ` (${dep.externalRef})` : ""}`,
      summary: [
        owner && `Owner: ${owner}`,
        dep.expectedAt && `Expected ${dep.expectedAt}`,
        `Status: ${dep.status}`,
      ]
        .filter(Boolean)
        .join(" · "),
      resolved: dep.status === "resolved",
    });
    const linkId = (result.response as { id?: number | string } | null)?.id;
    yield* query((d) =>
      d
        .update(dependencies)
        .set({ mirrorRemoteLinkId: linkId === undefined ? "mirrored" : String(linkId) })
        .where(eq(dependencies.id, id)),
    );
    return linkId ?? null;
  });

export const createDependency = (input: DependencyInput) =>
  Effect.gen(function* () {
    const v = DependencyInputSchema.parse(input);
    const id = newId();
    yield* query((d) => d.insert(dependencies).values({ id, ...v, requestedAt: nowIso() }));
    return id;
  });

/** Updates fields; a mirrored dependency's remote link is refreshed. */
export const updateDependency = (id: string, input: DependencyInput) =>
  Effect.gen(function* () {
    const v = DependencyInputSchema.parse(input);
    const existing = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!existing) return yield* notFound();
    const resolvedAt = v.status === "resolved" ? (existing.resolvedAt ?? nowIso()) : null;
    yield* query((d) =>
      d
        .update(dependencies)
        .set({ ...v, resolvedAt })
        .where(eq(dependencies.id, id)),
    );
    yield* refreshMirror(id);
  });

export const setStatus = (id: string, status: DependencyStatus) =>
  Effect.gen(function* () {
    yield* query((d) =>
      d
        .update(dependencies)
        .set({ status, resolvedAt: status === "resolved" ? nowIso() : null })
        .where(eq(dependencies.id, id)),
    );
    yield* refreshMirror(id);
  });

export const deleteDependency = (id: string) =>
  Effect.gen(function* () {
    yield* mirror(id, false).pipe(
      Effect.catchIf(
        (e) => e._tag === "ExecutorError",
        () => Effect.void,
      ),
    );
    yield* query((d) => d.delete(dependencies).where(eq(dependencies.id, id)));
  });

/** Records a chase and schedules the next one (FR-3.1 timeline). */
export const logFollowup = (id: string, input: FollowupInput, today = localDate()) =>
  Effect.gen(function* () {
    const v = FollowupInputSchema.parse(input);
    const settings = yield* Settings;
    const days =
      (yield* settings.get.pipe(Effect.orElseSucceed(() => undefined)))?.dependencies
        .followupDays ?? 3;
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!dep) return yield* notFound();
    const followupId = newId();
    yield* query((d) =>
      d.insert(followups).values({
        id: followupId,
        dependencyId: id,
        at: nowIso(),
        channel: v.channel,
        summary: v.summary,
        communicationId: v.communicationId,
      }),
    );
    const next = v.nextFollowupAt === undefined ? addBusinessDays(today, days) : v.nextFollowupAt;
    yield* query((d) =>
      d
        .update(dependencies)
        .set({
          nextFollowupAt: next,
          notifiedOn: null,
          status: dep.status === "open" ? "waiting" : dep.status,
        })
        .where(eq(dependencies.id, id)),
    );
    return followupId;
  });

/**
 * Saves a chase request for the Drafts page (the composer arrives in Phase 6),
 * grounded in the dependency: incident number, ask and first request date.
 */
export const requestChaseDraft = (id: string) =>
  Effect.gen(function* () {
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!dep) return yield* notFound();
    const person = dep.ownerPersonId
      ? yield* query((d) =>
          d
            .select()
            .from(people)
            .where(eq(people.id, dep.ownerPersonId ?? ""))
            .get(),
        )
      : undefined;
    const communicationId = newId();
    yield* query((d) =>
      d.insert(communications).values({
        id: communicationId,
        kind: person?.profile?.preferredChannel === "email" ? "email" : "teams",
        intent: "chase",
        recipientPersonId: dep.ownerPersonId,
        recipientTeamId: dep.ownerPersonId ? null : dep.ownerTeamId,
        issueKeys: [dep.issueKey],
        dependencyId: dep.id,
        notesMd: chaseNotes(dep),
        bodyMd: "",
        status: "draft",
        createdAt: nowIso(),
      }),
    );
    return communicationId;
  });

/** Open dependencies whose follow-up is due and that have not been announced today. */
export const dueForReminder = (today = localDate()) =>
  query((d) =>
    d
      .select({
        id: dependencies.id,
        issueKey: dependencies.issueKey,
        label: dependencies.label,
        nextFollowupAt: dependencies.nextFollowupAt,
      })
      .from(dependencies)
      .where(
        and(
          ne(dependencies.status, "resolved"),
          isNotNull(dependencies.nextFollowupAt),
          lte(dependencies.nextFollowupAt, today),
          or(sql`${dependencies.notifiedOn} IS NULL`, ne(dependencies.notifiedOn, today)),
        ),
      )
      .orderBy(asc(dependencies.nextFollowupAt))
      .all(),
  );

export const markNotified = (ids: readonly string[], today = localDate()) =>
  ids.length
    ? query((d) =>
        d
          .update(dependencies)
          .set({ notifiedOn: today })
          .where(inArray(dependencies.id, [...ids])),
      ).pipe(Effect.asVoid)
    : Effect.void;

/**
 * Dependencies and follow-ups (FR-3). Local writes are the user's own actions;
 * mirroring to Jira goes through the Executor.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { communications, dependencies, followups, jiraIssues, people, teams } from "@/db/schema";
import { addBusinessDays, localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { Executor, ExecutorError } from "@/services/executor";
import { Settings, settingsOrDefault } from "@/services/settings";
import { recordEvent } from "@/services/work/events";
import {
  chaseNotes,
  type DependencyStatus,
  mirrorGlobalId,
  mirrorUrl,
  type OwnerAway,
  type OwnerRef,
  timing,
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
  /** The person owner's away date (D47), for `timing`; null for teams and when not set. */
  ownerAway: OwnerAway | null;
  lastFollowupAt: string | null;
  followupCount: number;
};

/** A person owner's away date for `timing` (D47); teams have none. */
export const ownerAwayOf = (
  ownerPersonId: string | null,
  people: ReadonlyMap<string, { name: string; awayUntil: string | null }>,
): OwnerAway | null => {
  const p = ownerPersonId ? people.get(ownerPersonId) : undefined;
  return p?.awayUntil ? { name: p.name, awayUntil: p.awayUntil } : null;
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
    const persons = yield* query((d) =>
      d
        .select({ id: people.id, name: people.displayName, awayUntil: people.awayUntil })
        .from(people)
        .all(),
    );
    const away = new Map(persons.map((p) => [p.id, p]));
    const names = {
      person: new Map(persons.map((p) => [p.id, p.name])),
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
        ownerAway: ownerAwayOf(r.ownerPersonId, away),
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
    const owner = dep.ownerPersonId
      ? yield* query((d) =>
          d
            .select({ name: people.displayName, awayUntil: people.awayUntil })
            .from(people)
            .where(eq(people.id, dep.ownerPersonId ?? ""))
            .get(),
        )
      : undefined;
    return {
      dependency: dep,
      timeline,
      /** What `timing` needs beyond the row (D47). */
      timingInput: {
        ...dep,
        lastFollowupAt: timeline[0]?.at ?? null,
        ownerAway: ownerAwayOf(
          dep.ownerPersonId,
          new Map(owner ? [[dep.ownerPersonId ?? "", owner]] : []),
        ),
      },
    };
  });

const notFound = () =>
  new ExecutorError({ kind: "invalid", message: "That dependency no longer exists." });

/** The approval a Jira write belongs to, so the action log names it (D54 (4)). */
type LogOption = { proposalId?: string };

/**
 * Turns Jira mirroring on or off for one dependency (FR-3.4). `"refresh"` pushes
 * the current state of a mirrored dependency to its remote link and does nothing
 * for one that is not mirrored. Turning it off when Jira no longer has the link
 * (404) counts as done.
 */
export const mirror = (id: string, on: boolean | "refresh", opts: LogOption = {}) =>
  Effect.gen(function* () {
    const executor = yield* Executor;
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (on === "refresh" && !dep?.mirrorRemoteLinkId) return null;
    if (!dep) return yield* notFound();
    if (!on) {
      if (dep.mirrorRemoteLinkId) {
        yield* executor
          .run(
            {
              kind: "delete_remote_link",
              issueKey: dep.issueKey,
              globalId: mirrorGlobalId(dep.id),
            },
            opts,
          )
          .pipe(
            Effect.catchIf(
              (e) => e._tag === "JiraError" && e.status === 404,
              () => Effect.void,
            ),
          );
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
    const result = yield* executor.run(
      {
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
      },
      opts,
    );
    const linkId = (result.response as { id?: number | string } | null)?.id;
    yield* query((d) =>
      d
        .update(dependencies)
        .set({ mirrorRemoteLinkId: linkId === undefined ? "mirrored" : String(linkId) })
        .where(eq(dependencies.id, id)),
    );
    return linkId ?? null;
  });

/**
 * Whether a write is the user's own (the default), recorded as a work event
 * (D61); the Executor passes `event: false`, since its approved proposal is
 * the event.
 */
type EventOption = { event?: boolean };

const ownerName = (ownerPersonId: string | null, ownerTeamId: string | null) =>
  Effect.gen(function* () {
    if (ownerPersonId) {
      const p = yield* query((d) =>
        d
          .select({ name: people.displayName })
          .from(people)
          .where(eq(people.id, ownerPersonId))
          .get(),
      );
      if (p) return p.name;
    }
    if (ownerTeamId) {
      const t = yield* query((d) =>
        d.select({ name: teams.name }).from(teams).where(eq(teams.id, ownerTeamId)).get(),
      );
      if (t) return t.name;
    }
    return null;
  });

/** A wait opened, chased, rescheduled or resolved, as a work event on its ticket (D61). */
const waitEvent = (
  dep: Pick<Dependency, "id" | "issueKey" | "label" | "ownerPersonId" | "ownerTeamId">,
  kind: "wait_opened" | "wait_chased" | "wait_rescheduled" | "wait_resolved" | "wait_dropped",
  what: (owner: string) => string,
  text?: string | null,
) =>
  Effect.gen(function* () {
    const owner = (yield* ownerName(dep.ownerPersonId, dep.ownerTeamId)) ?? "someone";
    yield* recordEvent({
      kind,
      actor: "me",
      issueKey: dep.issueKey,
      ref: dep.id,
      summary: what(owner),
      data: {
        dependencyId: dep.id,
        ...(text ? { text } : {}),
        ...(dep.ownerPersonId ? { contactIds: [dep.ownerPersonId] } : {}),
      },
    });
  });

const datesText = (d: { expectedAt?: string | null; nextFollowupAt?: string | null }) =>
  [
    d.expectedAt !== undefined && (d.expectedAt ? `expected ${d.expectedAt}` : "no expected date"),
    d.nextFollowupAt !== undefined &&
      (d.nextFollowupAt ? `next chase ${d.nextFollowupAt}` : "no next chase"),
  ]
    .filter(Boolean)
    .join(", ");

export const createDependency = (input: DependencyInput, opts: EventOption = {}) =>
  Effect.gen(function* () {
    const v = DependencyInputSchema.parse(input);
    const id = newId();
    yield* query((d) => d.insert(dependencies).values({ id, ...v, requestedAt: nowIso() }));
    if (opts.event !== false)
      yield* waitEvent(
        {
          id,
          issueKey: v.issueKey,
          label: v.label,
          ownerPersonId: v.ownerPersonId ?? null,
          ownerTeamId: v.ownerTeamId ?? null,
        },
        "wait_opened",
        (owner) =>
          `Waiting on ${owner} for ${v.label} on ${v.issueKey}${v.expectedAt ? `, expected ${v.expectedAt}` : ""}`,
      );
    return id;
  });

/** Whether a write refreshes the Jira remote link of a mirrored dependency (default yes). */
type MirrorOption = { mirror?: boolean } & EventOption;

/**
 * Updates fields; a mirrored dependency's remote link is refreshed unless
 * `mirror` is false (the Executor refreshes it itself, so a Jira failure is a
 * warning after the local write, D46).
 */
export const updateDependency = (id: string, input: DependencyInput, opts: MirrorOption = {}) =>
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
    if (opts.event !== false) {
      const dep = { ...existing, ...v };
      if (v.status === "resolved" && existing.status !== "resolved")
        yield* waitEvent(dep, "wait_resolved", (o) => `${o} delivered ${v.label} (resolved)`);
      else if (
        (v.expectedAt ?? null) !== existing.expectedAt ||
        (v.nextFollowupAt ?? null) !== existing.nextFollowupAt
      )
        yield* waitEvent(
          dep,
          "wait_rescheduled",
          (o) =>
            `Wait on ${o} for ${v.label}: ${datesText({ expectedAt: v.expectedAt ?? null, nextFollowupAt: v.nextFollowupAt ?? null })}`,
        );
    }
    if (opts.mirror !== false) yield* mirror(id, "refresh");
  });

/**
 * Reschedules a dependency: a new expected date and/or next follow-up (a key
 * left out keeps its value). A mirrored remote link is refreshed unless
 * `mirror` is false.
 */
export const setDates = (
  id: string,
  dates: { expectedAt?: string | null; nextFollowupAt?: string | null },
  opts: MirrorOption = {},
) =>
  Effect.gen(function* () {
    const set = Object.fromEntries(Object.entries(dates).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) return;
    const existing = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    if (!existing) return yield* notFound();
    // A new follow-up date is a new reminder.
    const notified = "nextFollowupAt" in set ? { notifiedOn: null } : {};
    yield* query((d) =>
      d
        .update(dependencies)
        .set({ ...set, ...notified })
        .where(eq(dependencies.id, id)),
    );
    if (opts.event !== false)
      yield* waitEvent(
        existing,
        "wait_rescheduled",
        (o) => `Wait on ${o} for ${existing.label}: ${datesText(dates)}`,
      );
    if (opts.mirror !== false) yield* mirror(id, "refresh");
  });

/**
 * `dropped`: the user stopped waiting (no longer needed), with their reason; it
 * is recorded as such, not as the owner delivering (D61).
 */
export const setStatus = (
  id: string,
  status: DependencyStatus,
  opts: MirrorOption & { dropped?: string } = {},
) =>
  Effect.gen(function* () {
    const existing = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
    );
    yield* query((d) =>
      d
        .update(dependencies)
        .set({ status, resolvedAt: status === "resolved" ? nowIso() : null })
        .where(eq(dependencies.id, id)),
    );
    if (opts.event !== false && existing && status === "resolved" && existing.status !== "resolved")
      yield* opts.dropped
        ? waitEvent(
            existing,
            "wait_dropped",
            (o) => `You stopped waiting on ${o} for ${existing.label}`,
            opts.dropped,
          )
        : waitEvent(
            existing,
            "wait_resolved",
            (o) => `${o} delivered ${existing.label} (resolved)`,
          );
    if (opts.mirror !== false) yield* mirror(id, "refresh");
  });

/**
 * Deletes a dependency and the remote link that mirrors it. A link Jira refuses
 * to remove (other than gone) leaves the dependency; `proposalId` logs the
 * delete with a revoke (D54).
 */
export const deleteDependency = (id: string, opts: LogOption = {}) =>
  Effect.gen(function* () {
    yield* mirror(id, false, opts).pipe(
      Effect.catchIf(
        (e) => e._tag === "ExecutorError",
        () => Effect.void,
      ),
    );
    yield* query((d) => d.delete(dependencies).where(eq(dependencies.id, id)));
  });

/** Records a chase and schedules the next one (FR-3.1 timeline). */
export const logFollowup = (
  id: string,
  input: FollowupInput,
  today = localDate(),
  opts: EventOption = {},
) =>
  Effect.gen(function* () {
    const v = FollowupInputSchema.parse(input);
    const days = (yield* settingsOrDefault(yield* Settings)).dependencies.followupDays;
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
    if (opts.event !== false)
      yield* waitEvent(
        dep,
        "wait_chased",
        (o) => `Followed up with ${o} on ${dep.label}${next ? `; next chase ${next}` : ""}`,
        v.summary,
      );
    return followupId;
  });

/**
 * Saves a chase request for the Drafts page, where the composer writes it,
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

/**
 * Open dependencies whose follow-up is due by `timing` (so not while the owner
 * is away, and due once they are back, D47) and that have not been announced
 * today, earliest due first, with the reason to show ("Bob is back").
 */
export const dueForReminder = (today = localDate()) =>
  Effect.map(listDependencies(), (rows) =>
    rows
      .filter((r) => r.notifiedOn !== today)
      .map((r) => ({ r, t: timing(r, today) }))
      .filter(({ t }) => t.followupDue)
      .sort((a, b) => (a.t.followupOn ?? "").localeCompare(b.t.followupOn ?? ""))
      .map(({ r, t }) => ({
        id: r.id,
        issueKey: r.issueKey,
        label: r.label,
        nextFollowupAt: r.nextFollowupAt,
        reason: t.reason,
      })),
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

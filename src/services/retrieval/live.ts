import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  contextNotes,
  dependencies,
  issueMeta,
  jiraIssues,
  memories,
  people,
  proposals,
  teams,
} from "@/db/schema";
import { nowIso } from "@/lib/ids";
import {
  type CandidateIssue,
  CLASSIFY_PROMPT_VERSION,
  ISSUE_KEY_SCAN,
  type ItemSnapshot,
} from "@/prompts/classify";
import { takeWithinBudget } from "@/prompts/common";
import { renderWorkItem, type WorkItemSnapshot } from "@/prompts/work-block";
import { parseLinkTypes } from "@/services/blockers/logic";
import { blockLinks } from "@/services/dashboard/sections";
import { bindDb, Db } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { isAway } from "@/services/directory/away";
import { normalizeUsername } from "@/services/directory/schema";
import { parseIssueLinks } from "@/services/jira/schemas";
import { describeCorrection, describeStoredPayload } from "@/services/proposals/schema";
import { Settings, settingsOrDefault } from "@/services/settings";
import { defaultSmallAskType, smallAskTypes } from "@/services/small-asks/home";
import { userActiveSprints } from "@/services/sprints/active";
import { promptSprints } from "@/services/sprints/calendar";
import { deletedKeys, stillRevoked } from "@/services/sync/deleted";
import { getState, parseProjectMeta, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import { loadWorkBlock } from "@/services/work/reads";
import { BUDGETS, CANDIDATE_LIMIT, Retrieval, type SnapshotRequest, WORK_CANDIDATE_LIMIT } from ".";
import { pointScale, pointUses } from "./points";
import {
  mergeCandidates,
  orderPriorities,
  type Reason,
  rankByRelevance,
  rankMemories,
  retrievalFtsQuery,
} from "./ranking";
import { pickWaits } from "./waits";

const FTS_LIMIT = 15;
const RECENT_LIMIT = 5;
const PEOPLE_ALL_THRESHOLD = 30;
const NOTE_EXCERPT = 600;

const make = Effect.gen(function* () {
  const settingsSvc = yield* Settings;
  const { q, withDb } = bindDb(yield* Db);

  const snapshot = (req: SnapshotRequest) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      const me = yield* withDb(getState(SYNC_KEYS.username));
      const allPeople = yield* q((d) => d.select().from(people).all());
      const allTeams = yield* q((d) => d.select().from(teams).all());
      const teamName = new Map(allTeams.map((t) => [t.id, t.name]));
      const sender = req.senderPersonId
        ? allPeople.find((p) => p.id === req.senderPersonId)
        : undefined;

      // --- candidate issues -------------------------------------------------
      const mentioned = req.references.issueKeys.length
        ? (yield* q((d) =>
            d
              .select({ key: jiraIssues.key })
              .from(jiraIssues)
              .where(inArray(jiraIssues.key, req.references.issueKeys))
              .all(),
          )).map((r) => r.key)
        : [];
      const match = retrievalFtsQuery(req.quote);
      const searched = match
        ? (yield* q((d) =>
            d.all<
              [string]
            >(sql`SELECT j.key FROM jira_issues_fts f JOIN ${jiraIssues} j ON j.rowid = f.rowid
              WHERE jira_issues_fts MATCH ${match} AND j.stale = 0 ORDER BY bm25(jira_issues_fts) LIMIT ${FTS_LIMIT}`),
          )).map((r) => r[0])
        : [];
      const viewed = (yield* q((d) =>
        d
          .select({ key: issueMeta.issueKey })
          .from(issueMeta)
          .where(isNotNull(issueMeta.lastViewedAt))
          .orderBy(desc(issueMeta.lastViewedAt))
          .limit(RECENT_LIMIT)
          .all(),
      )).map((r) => r.key);
      const updated = (yield* q((d) =>
        d
          .select({ key: jiraIssues.key })
          .from(jiraIssues)
          .where(and(eq(jiraIssues.stale, false), ne(jiraIssues.statusCategory, "done")))
          .orderBy(desc(jiraIssues.updated))
          .limit(RECENT_LIMIT)
          .all(),
      )).map((r) => r.key);
      const senderUser = normalizeUsername(sender?.jiraUsername);
      const senderIssues = senderUser
        ? (yield* q((d) =>
            d
              .select({ key: jiraIssues.key })
              .from(jiraIssues)
              .where(
                and(
                  sql`lower(${jiraIssues.assignee}) = ${senderUser}`,
                  eq(jiraIssues.stale, false),
                  ne(jiraIssues.statusCategory, "done"),
                ),
              )
              .orderBy(desc(jiraIssues.updated))
              .limit(3)
              .all(),
          )).map((r) => r.key)
        : [];
      const tracked = (yield* q((d) =>
        d
          .select({ key: jiraIssues.key })
          .from(jiraIssues)
          .where(eq(jiraIssues.isTrackedEpic, true))
          .all(),
      )).map((r) => r.key);

      // Tickets a revoke deleted, in this thread or any other, are never offered,
      // whichever source finds them (FR-14.6).
      const tombstoned = yield* withDb(deletedKeys);
      const excluded = new Set([...(req.exclude ?? []), ...tombstoned]);
      // Tickets a revoke closed, while they stay closed: offered only when the
      // user's words or the thread name them, never found by search, recency,
      // sender, tracking or as an epic (FR-14.6).
      const closedByRevoke = new Set(
        (yield* q((d) =>
          d
            .select({
              key: jiraIssues.key,
              status: jiraIssues.status,
              statusCategory: jiraIssues.statusCategory,
            })
            .from(jiraIssues)
            .innerJoin(issueMeta, eq(issueMeta.issueKey, jiraIssues.key))
            .where(isNotNull(issueMeta.revokedAt))
            .all(),
        ))
          .filter(stillRevoked)
          .map((r) => r.key),
      );
      // --- the work items the input touches (D61 Reads, prompt version 15) ------
      // Read before the candidates: their tickets are candidates the model may act on.
      const openWaits = (yield* withDb(listDependencies()))
        // A wait made outside the thread may still point at a deleted ticket.
        .filter((d) => !excluded.has(d.issueKey));
      const named = new Set(mentioned);
      const reachedWork = settings.work.enabled
        ? (yield* withDb(
            loadWorkBlock({
              ownKeys: (req.ownKeys ?? req.references.issueKeys).filter((k) => !excluded.has(k)),
              keys: req.references.issueKeys.filter((k) => !excluded.has(k)),
              senderPersonId: sender?.id ?? null,
              contactIds: req.references.contactIds,
              ownInput: req.ownInput ?? false,
              today: req.today,
              waits: openWaits,
              ...(req.inboxItemId ? { inboxItemId: req.inboxItemId } : {}),
            }),
          )).map((w) => ({
            ...w,
            // Deleted tickets are gone; a ticket a revoke closed is shown only when named (FR-14.6).
            keys: w.keys.filter(
              (k) => !excluded.has(k.key) && (!closedByRevoke.has(k.key) || named.has(k.key)),
            ),
          }))
        : [];
      // The primary tickets of items a signal reached pass the limit like named ones, at
      // most WORK_CANDIDATE_LIMIT; their other tickets, and those of an item listed only
      // because the user is on it, rank after search and count against the limit.
      const pinnedWork = [
        ...new Set(
          reachedWork
            .filter((w) => w.reasons.some((r) => r !== "current"))
            .flatMap((w) => w.keys.filter((k) => k.role === "primary").map((k) => k.key)),
        ),
      ].slice(0, WORK_CANDIDATE_LIMIT);
      const pinned = new Set(pinnedWork);
      const otherWork = [...new Set(reachedWork.flatMap((w) => w.keys.map((k) => k.key)))].filter(
        (k) => !pinned.has(k),
      );
      const sources: [Reason, string[], boolean?][] = [
        ["mentioned", mentioned],
        ["work", pinnedWork, true],
        ["search", searched],
        ["work", otherWork],
        ["sender", senderIssues],
        ["recent", [...viewed, ...updated]],
        ["tracked", tracked],
      ];
      const found = [...(req.exclude ?? []), ...sources.flatMap(([, keys]) => keys)];
      /** Deleted tickets this item could reach: validation says why they are no target. */
      const reached = new Set(found.filter((k) => excluded.has(k)));
      /** Closed-by-revoke tickets this item could reach but is not offered. */
      const reachedClosed = new Set(
        found.filter((k) => closedByRevoke.has(k) && !mentioned.includes(k)),
      );
      const merged = mergeCandidates(
        sources.map(([reason, keys, keep]): [Reason, string[], boolean?] => [
          reason,
          keys.filter(
            (k) => !excluded.has(k) && (reason === "mentioned" || !closedByRevoke.has(k)),
          ),
          keep,
        ]),
        CANDIDATE_LIMIT,
      );
      const rowsFor = (keys: string[]) =>
        keys.length
          ? q((d) => d.select().from(jiraIssues).where(inArray(jiraIssues.key, keys)).all())
          : Effect.succeed([] as (typeof jiraIssues.$inferSelect)[]);
      let rows = yield* rowsFor([...merged.keys()]);
      // Epics of candidates, so the model can file new work under them.
      const epicKeys = [
        ...new Set(
          rows
            .map((r) => r.epicKey)
            .filter(
              (k): k is string =>
                !!k && !merged.has(k) && !excluded.has(k) && !closedByRevoke.has(k),
            ),
        ),
      ];
      for (const k of epicKeys) merged.set(k, ["epic" as Reason]);
      rows = [...rows, ...(yield* rowsFor(epicKeys))];
      const byKey = new Map(rows.map((r) => [r.key, r]));
      // A ticket the user revoked and the revoke closed says so while it stays closed,
      // and whether that was in this thread.
      const revokedHere = new Set(req.revokedHere ?? []);
      const candidates: CandidateIssue[] = takeWithinBudget(
        [...merged]
          .map(([key, reasons]) => ({ row: byKey.get(key), reasons }))
          .filter((c): c is { row: typeof jiraIssues.$inferSelect; reasons: Reason[] } => !!c.row)
          .map(({ row, reasons }) => ({
            key: row.key,
            summary: row.summary,
            issueType: row.issueType,
            status: row.status,
            statusCategory: row.statusCategory,
            projectKey: row.projectKey,
            epicKey: row.epicKey,
            parentKey: row.parentKey,
            assignee: row.assignee,
            priority: row.priority,
            dueDate: row.dueDate,
            storyPoints: row.storyPoints,
            updated: row.updated,
            reasons,
            // Existing "blocked by" links, so the model does not propose them again (D45).
            blockedBy: blockLinks(
              parseIssueLinks((row.raw as { issuelinks?: unknown } | null)?.issuelinks),
            )
              .filter((l) => l.direction === "blockedBy")
              .map((l) => l.key),
            ...(closedByRevoke.has(row.key)
              ? { revoked: revokedHere.has(row.key) ? ("here" as const) : ("elsewhere" as const) }
              : {}),
          })),
        (c) => `${c.key} ${c.summary} ${c.status} ${c.issueType}`,
        BUDGETS.candidates,
        // Named tickets and the work block's pinned ones come first and always stay.
        [...merged].filter(([k, r]) => r.includes("mentioned") || pinned.has(k)).length,
      );

      // --- projects, priorities, users --------------------------------------
      const projectRows = yield* q((d) =>
        d.all<[string, string, string]>(
          sql`SELECT DISTINCT project_key, issue_type, status FROM ${jiraIssues} WHERE stale = 0`,
        ),
      );
      const projects = new Map<
        string,
        { key: string; issueTypes: Set<string>; statuses: Set<string> }
      >();
      // Jira's project metadata (read at sync) is authoritative; the cache only adds
      // projects it does not cover.
      const projectMeta = parseProjectMeta(yield* withDb(getState(SYNC_KEYS.projectMeta)));
      for (const [key, type, status] of projectRows) {
        const p = projects.get(key) ?? { key, issueTypes: new Set(), statuses: new Set() };
        p.issueTypes.add(type);
        p.statuses.add(status);
        projects.set(key, p);
      }
      // The small-asks home is a project to create in even with none of its issues cached (D44).
      const homeKey = settings.smallAsks.projectKey;
      if (homeKey && !projects.has(homeKey))
        projects.set(homeKey, { key: homeKey, issueTypes: new Set(), statuses: new Set() });
      const homeTypes = homeKey
        ? (projectMeta[homeKey]?.issueTypes ?? [...(projects.get(homeKey)?.issueTypes ?? [])])
        : [];
      // Jira's sub-task flag where sync stored it; the name decides only without it.
      const homeSubtasks = homeKey ? (projectMeta[homeKey]?.subtaskTypes ?? null) : null;
      const smallAsks = homeKey
        ? {
            projectKey: homeKey,
            label: settings.smallAsks.label,
            joinSprint: settings.smallAsks.joinActiveSprint,
            issueTypes: smallAskTypes(homeTypes, homeSubtasks).sort(),
            defaultType: defaultSmallAskType([...homeTypes].sort(), homeSubtasks),
            defaultPoints: settings.smallAsks.defaultPoints,
          }
        : null;
      const priorities = orderPriorities(
        (yield* q((d) =>
          d.all<[string]>(
            sql`SELECT DISTINCT priority FROM ${jiraIssues} WHERE priority IS NOT NULL`,
          ),
        )).map((r) => r[0]),
      );
      const userRows = yield* q((d) =>
        d.all<[string, string | null, number]>(sql`SELECT u, MAX(n), COUNT(*) c FROM (
          SELECT assignee u, assignee_display n FROM ${jiraIssues} WHERE assignee IS NOT NULL
          UNION ALL SELECT reporter, reporter_display FROM ${jiraIssues} WHERE reporter IS NOT NULL
        ) GROUP BY u ORDER BY c DESC`),
      );
      const candidateUsers = new Set(candidates.map((c) => c.assignee).filter(Boolean));
      const jiraUsers = takeWithinBudget(
        userRows
          .map(([username, display]) => ({ username, displayName: display ?? username }))
          .sort(
            (a, b) =>
              Number(candidateUsers.has(b.username)) - Number(candidateUsers.has(a.username)),
          ),
        (u) => `${u.username} (${u.displayName}), `,
        BUDGETS.jiraUsers,
      );

      // --- directory ----------------------------------------------------------
      const assigneeContacts = new Set(
        allPeople
          .filter((p) => p.jiraUsername && candidateUsers.has(p.jiraUsername))
          .map((p) => p.id),
      );
      const relevantPeople =
        allPeople.length <= PEOPLE_ALL_THRESHOLD
          ? allPeople
          : allPeople.filter(
              (p) =>
                req.references.contactIds.includes(p.id) ||
                p.id === sender?.id ||
                (sender?.teamId && p.teamId === sender.teamId) ||
                assigneeContacts.has(p.id),
            );
      const peopleOut = takeWithinBudget(
        relevantPeople.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          title: p.title,
          team: p.teamId ? (teamName.get(p.teamId) ?? null) : null,
          jiraUsername: p.jiraUsername,
          // Only while away, so the model does not propose the date again (D47).
          ...(isAway(p.awayUntil, req.today) ? { awayUntil: p.awayUntil } : {}),
          // For the duplicate check of a new contact only (D60); the prompt leaves it out.
          ...(p.email ? { email: p.email } : {}),
        })),
        (p) => `${p.id} ${p.displayName} ${p.title ?? ""} ${p.team ?? ""}`,
        BUDGETS.people,
      );
      const teamsOut = takeWithinBudget(
        allTeams.map((t) => ({
          id: t.id,
          name: t.name,
          function: t.function,
          contactFor: t.contactFor,
        })),
        (t) => `${t.id} ${t.name} ${t.function ?? ""} ${t.contactFor ?? ""}`,
        BUDGETS.teams,
      );

      const deps = candidates.length
        ? yield* q((d) =>
            d
              .select({
                issueKey: dependencies.issueKey,
                label: dependencies.label,
                status: dependencies.status,
              })
              .from(dependencies)
              .where(
                and(
                  inArray(
                    dependencies.issueKey,
                    candidates.map((c) => c.key),
                  ),
                  ne(dependencies.status, "resolved"),
                ),
              )
              .all(),
          )
        : [];

      // --- open waits update_dependency may pick (D46) ------------------------
      const personTeam = new Map(allPeople.map((p) => [p.id, p.teamId]));
      const waits = pickWaits(
        openWaits.map((d) => ({
          id: d.id,
          issueKey: d.issueKey,
          label: d.label,
          kind: d.kind,
          externalRef: d.externalRef,
          status: d.status,
          ownerPersonId: d.ownerPersonId,
          ownerTeamId: d.ownerTeamId,
          owner: d.owner.type === "none" ? null : d.owner.name,
          ownerPersonTeamId: d.ownerPersonId ? (personTeam.get(d.ownerPersonId) ?? null) : null,
          ownerAwayUntil: d.ownerAway?.awayUntil ?? null,
          requestedAt: d.requestedAt,
          expectedAt: d.expectedAt,
          nextFollowupAt: d.nextFollowupAt,
          issueSummary: d.issueSummary,
        })),
        {
          senderPersonId: sender?.id ?? null,
          senderTeamId: sender?.teamId ?? null,
          namedPersonIds: req.references.contactIds,
          candidateKeys: candidates.map((c) => c.key),
          mentionedKeys: req.references.issueKeys,
          quote: req.quote,
          today: req.today,
        },
      );
      // The work block offers only waits update_dependency may pick (D46), measured
      // against its budget as the prompt shows it.
      const offered = new Set(waits.map((w) => w.id));
      const work: WorkItemSnapshot[] = takeWithinBudget(
        reachedWork.map((w) => ({ ...w, waits: w.waits.filter((x) => offered.has(x.id)) })),
        renderWorkItem,
        BUDGETS.work,
        1,
      );

      // --- memories and correction examples (D26) ---------------------------
      // A correction from a thread whose created ticket was then revoked is not
      // learning material: it corrected a mistake the user undid (FR-14.6).
      const revokedThreads = new Set(
        (yield* q((d) =>
          d
            .selectDistinct({ id: proposals.inboxItemId })
            .from(proposals)
            .where(and(eq(proposals.kind, "create_issue"), eq(proposals.status, "revoked")))
            .all(),
        )).map((r) => r.id),
      );
      const memoryRows = (yield* q((d) =>
        d.select().from(memories).where(eq(memories.confirmed, true)).all(),
      )).filter(
        (m) =>
          // Work item corrections teach the grouping, not classify (D61); answers to
          // "make that the rule?" are about the playbooks (Phase 26).
          m.subjectType !== "work_item" &&
          m.subjectType !== "playbook" &&
          (m.kind !== "example" ||
            !m.sourceInboxItemId ||
            !revokedThreads.has(m.sourceInboxItemId)),
      );
      const about = new Set([
        ...candidates.map((c) => `issue:${c.key}`),
        ...req.references.contactIds.map((id) => `person:${id}`),
        ...(sender ? [`person:${sender.id}`] : []),
        ...(sender?.teamId ? [`team:${sender.teamId}`] : []),
      ]);
      const pickedRules = takeWithinBudget(
        rankMemories(
          memoryRows
            .filter((m) => m.kind !== "example")
            .map((m) => ({ ...m, text: m.content, at: m.lastUsedAt ?? m.createdAt })),
          req.quote,
          about,
          20,
        ),
        (m) => m.content,
        BUDGETS.memories,
      );
      const pickedExamples = takeWithinBudget(
        rankMemories(
          memoryRows
            .filter((m) => m.kind === "example")
            .map((m) => ({ ...m, text: m.exampleInput ?? m.content, at: m.createdAt })),
          req.quote,
          about,
          10,
        ),
        (m) => `${m.exampleInput ?? ""} ${m.content}`.slice(0, 1200),
        BUDGETS.examples,
      );
      const rules = pickedRules.map((m) => ({ kind: m.kind, content: m.content }));
      const examples = pickedExamples.map((m) => ({
        input: (m.exampleInput ?? "").slice(0, 300),
        proposed: describeStoredPayload(m.exampleBefore),
        corrected: m.exampleAfter ? describeCorrection(m.exampleBefore, m.exampleAfter) : null,
      }));
      // A deleted ticket a past example or rule names: validation says why it is no target.
      for (const text of [
        ...rules.map((m) => m.content),
        ...examples.flatMap((x) => [x.input, x.proposed, x.corrected ?? ""]),
      ])
        for (const k of text.match(ISSUE_KEY_SCAN) ?? []) {
          if (excluded.has(k)) reached.add(k);
          else if (closedByRevoke.has(k) && !mentioned.includes(k)) reachedClosed.add(k);
        }
      const used = [...pickedRules, ...pickedExamples].map((m) => m.id);
      if (used.length)
        yield* q((d) =>
          d
            .update(memories)
            .set({ lastUsedAt: nowIso(), useCount: sql`${memories.useCount} + 1` })
            .where(inArray(memories.id, used)),
        );

      // --- context notes ------------------------------------------------------
      const subjects = [
        ...req.references.contactIds.map((id) => ["person", id] as const),
        ...(sender ? [["person", sender.id] as const] : []),
        ...(sender?.teamId ? [["team", sender.teamId] as const] : []),
        ...candidates
          .filter((c) => c.reasons.includes("mentioned"))
          .map((c) => ["issue", c.key] as const),
      ];
      const noteRows = subjects.length
        ? yield* q((d) =>
            d
              .select()
              .from(contextNotes)
              .where(
                sql`(${contextNotes.subjectType}, ${contextNotes.subjectId}) IN (VALUES ${sql.join(
                  subjects.map(([t, id]) => sql`(${t}, ${id})`),
                  sql`, `,
                )})`,
              )
              .all(),
          )
        : [];
      const aboutName = (type: string, id: string) =>
        type === "person"
          ? (allPeople.find((p) => p.id === id)?.displayName ?? id)
          : type === "team"
            ? (teamName.get(id) ?? id)
            : id;
      const notes = takeWithinBudget(
        rankByRelevance(
          noteRows.map((n) => ({ ...n, text: `${n.title} ${n.bodyMd}`, at: n.importedAt })),
          req.quote,
          6,
        ).map((n) => ({
          about: aboutName(n.subjectType, n.subjectId),
          title: n.title,
          excerpt: n.bodyMd.replace(/\s+/g, " ").slice(0, NOTE_EXCERPT),
        })),
        (n) => `${n.title} ${n.excerpt}`,
        BUDGETS.notes,
      );

      // --- sprint calendar (D23) -----------------------------------------------
      const sprintState = parseSprintState(yield* withDb(getState(SYNC_KEYS.sprints)));
      const sprints = promptSprints(sprintState, {
        today: req.today,
        fyStartMonth: settings.general.fiscalYearStartMonth,
        projects: [...projects.keys()],
      });

      // --- the user's active sprints (D57): code's default for joinSprint, not shown to the model ---
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
      const userSprints = userActiveSprints(sprintState.sprints, mine, me ?? null).map((s) => ({
        name: s.name,
        end: s.end,
        projects: s.boardId === null ? [] : (sprintState.boardProjects[String(s.boardId)] ?? []),
      }));

      // --- story point scale (D55): the candidates' projects and the home first ---
      const pointScaleValues = pointScale(yield* withDb(pointUses), [
        ...new Set([...candidates.map((c) => c.projectKey), ...(homeKey ? [homeKey] : [])]),
      ]);

      return {
        promptVersion: CLASSIFY_PROMPT_VERSION,
        today: req.today,
        askedOn: req.askedOn ?? req.today,
        me: me ? { username: me } : null,
        outputLanguage: settings.general.outputLanguage,
        source: req.source,
        sender: sender
          ? {
              id: sender.id,
              displayName: sender.displayName,
              title: sender.title,
              team: sender.teamId ? (teamName.get(sender.teamId) ?? null) : null,
            }
          : null,
        quote: req.quote,
        thread: req.thread ?? null,
        references: {
          issueKeys: req.references.issueKeys.filter((k) => !excluded.has(k)),
          tickets: req.references.tickets,
          urls: req.references.urls,
          contactIds: req.references.contactIds,
        },
        candidates,
        projects: [...projects.values()]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((p) => {
            const meta = projectMeta[p.key];
            return meta
              ? {
                  key: p.key,
                  issueTypes: meta.issueTypes,
                  statuses: meta.statuses,
                  complete: true,
                  ...(meta.subtaskTypes ? { subtaskTypes: meta.subtaskTypes } : {}),
                }
              : {
                  key: p.key,
                  issueTypes: [...p.issueTypes].sort(),
                  statuses: [...p.statuses].sort(),
                  complete: false,
                };
          }),
        priorities,
        jiraUsers,
        teams: teamsOut,
        people: peopleOut,
        dependencies: deps,
        waits,
        work,
        memories: rules,
        examples,
        notes,
        sprints,
        userSprints,
        pointScale: pointScaleValues,
        smallAsks,
        blockLinkType:
          parseLinkTypes(yield* withDb(getState(SYNC_KEYS.linkTypes))).blocks?.name ?? null,
        ...(reached.size ? { deleted: [...reached].sort() } : {}),
        ...(reachedClosed.size ? { revokedClosed: [...reachedClosed].sort() } : {}),
      } satisfies ItemSnapshot;
    });

  return Retrieval.of({ snapshot });
});

export const RetrievalLive = Layer.effect(Retrieval, make);

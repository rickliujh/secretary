import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  contextNotes,
  dependencies,
  issueMeta,
  jiraIssues,
  memories,
  people,
  teams,
} from "@/db/schema";
import {
  type CandidateIssue,
  CLASSIFY_PROMPT_VERSION,
  type ItemSnapshot,
} from "@/prompts/classify";
import { takeWithinBudget } from "@/prompts/common";
import { Db, query } from "@/services/db";
import { normalizeUsername } from "@/services/directory/schema";
import { describePayload, ProposalPayloadSchema } from "@/services/proposals/schema";
import { Settings } from "@/services/settings";
import { promptSprints } from "@/services/sprints/calendar";
import { getState, parseProjectMeta, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import { BUDGETS, CANDIDATE_LIMIT, Retrieval, type SnapshotRequest } from ".";
import {
  mergeCandidates,
  orderPriorities,
  type Reason,
  rankByRelevance,
  retrievalFtsQuery,
} from "./ranking";

const FTS_LIMIT = 15;
const RECENT_LIMIT = 5;
const PEOPLE_ALL_THRESHOLD = 30;
const NOTE_EXCERPT = 600;

const describeExample = (value: unknown): string => {
  // Revisions store the before and after sets (D22).
  if (Array.isArray(value)) return value.map(describeExample).join("; ") || "nothing";
  const r = ProposalPayloadSchema.safeParse(value);
  return r.success ? describePayload(r.data) : JSON.stringify(value);
};

const make = Effect.gen(function* () {
  const db = yield* Db;
  const settingsSvc = yield* Settings;
  const q = <A>(f: Parameters<typeof query<A>>[0]) => Effect.provideService(query(f), Db, db);

  const snapshot = (req: SnapshotRequest) =>
    Effect.gen(function* () {
      const settings = yield* settingsSvc.get.pipe(Effect.orElseSucceed(() => undefined));
      const me = yield* Effect.provideService(getState(SYNC_KEYS.username), Db, db);
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

      const merged = mergeCandidates(
        [
          ["mentioned", mentioned],
          ["search", searched],
          ["sender", senderIssues],
          ["recent", [...viewed, ...updated]],
          ["tracked", tracked],
        ],
        CANDIDATE_LIMIT,
      );
      const rowsFor = (keys: string[]) =>
        keys.length
          ? q((d) => d.select().from(jiraIssues).where(inArray(jiraIssues.key, keys)).all())
          : Effect.succeed([] as (typeof jiraIssues.$inferSelect)[]);
      let rows = yield* rowsFor([...merged.keys()]);
      // Epics of candidates, so the model can file new work under them.
      const epicKeys = [
        ...new Set(rows.map((r) => r.epicKey).filter((k): k is string => !!k && !merged.has(k))),
      ];
      for (const k of epicKeys) merged.set(k, ["epic" as Reason]);
      rows = [...rows, ...(yield* rowsFor(epicKeys))];
      const byKey = new Map(rows.map((r) => [r.key, r]));
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
            updated: row.updated,
            reasons,
          })),
        (c) => `${c.key} ${c.summary} ${c.status} ${c.issueType}`,
        BUDGETS.candidates,
        mentioned.length,
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
      const projectMeta = parseProjectMeta(
        yield* Effect.provideService(getState(SYNC_KEYS.projectMeta), Db, db),
      );
      for (const [key, type, status] of projectRows) {
        const p = projects.get(key) ?? { key, issueTypes: new Set(), statuses: new Set() };
        p.issueTypes.add(type);
        p.statuses.add(status);
        projects.set(key, p);
      }
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

      // --- memories and correction examples --------------------------------
      const memoryRows = yield* q((d) =>
        d.select().from(memories).where(eq(memories.confirmed, true)).all(),
      );
      const rules = takeWithinBudget(
        rankByRelevance(
          memoryRows
            .filter((m) => m.kind !== "example")
            .map((m) => ({ ...m, text: m.content, at: m.lastUsedAt ?? m.createdAt })),
          req.quote,
          20,
        ).map((m) => ({ kind: m.kind, content: m.content })),
        (m) => m.content,
        BUDGETS.memories,
      );
      const examples = takeWithinBudget(
        rankByRelevance(
          memoryRows
            .filter((m) => m.kind === "example")
            .map((m) => ({ ...m, text: m.exampleInput ?? m.content, at: m.createdAt })),
          req.quote,
          10,
        ).map((m) => ({
          input: (m.exampleInput ?? "").slice(0, 300),
          proposed: describeExample(m.exampleBefore),
          corrected: m.exampleAfter ? describeExample(m.exampleAfter) : null,
        })),
        (e) => `${e.input} ${e.proposed} ${e.corrected ?? ""}`,
        BUDGETS.examples,
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
      const sprintState = parseSprintState(
        yield* Effect.provideService(getState(SYNC_KEYS.sprints), Db, db),
      );
      const sprints = promptSprints(sprintState, {
        today: req.today,
        fyStartMonth: settings?.general.fiscalYearStartMonth ?? 1,
        projects: [...projects.keys()],
      });

      return {
        promptVersion: CLASSIFY_PROMPT_VERSION,
        today: req.today,
        me: me ? { username: me } : null,
        outputLanguage: settings?.general.outputLanguage ?? "English",
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
        clarification: req.clarification ?? null,
        thread: req.thread ?? null,
        references: {
          issueKeys: req.references.issueKeys,
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
              ? { key: p.key, issueTypes: meta.issueTypes, statuses: meta.statuses, complete: true }
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
        memories: rules,
        examples,
        notes,
        sprints,
      } satisfies ItemSnapshot;
    });

  return Retrieval.of({ snapshot });
});

export const RetrievalLive = Layer.effect(Retrieval, make);

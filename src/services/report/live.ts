import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import { z } from "zod";
import { followups, jiraComments, jiraIssues } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { readJson } from "@/lib/json";
import {
  buildReportPrompt,
  buildReportSchema,
  isQuiet,
  type ReportFacts,
  type ReportOutput,
  validateReport,
} from "@/prompts/report";
import { loadDashboardInputs } from "@/services/dashboard/data";
import { blockInfo, buildDashboard } from "@/services/dashboard/sections";
import { bindDb, Db } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { JiraClient } from "@/services/jira";
import { IssueLinkSchema } from "@/services/jira/schemas";
import { Llm } from "@/services/llm";
import { Settings, settingsOrDefault } from "@/services/settings";
import { getState, parseSprintState, SYNC_KEYS, setState } from "@/services/sync/state";
import { type Report, ReportError, type ReportRequest, Reports } from ".";
import {
  askText,
  buildRecapFacts,
  type HistoryEntry,
  type RecapIssue,
  reportWindow,
} from "./facts";

const CACHE_KEY = "report.last";
/** Jira history is read for at most this many recently updated tickets, a few at a time. */
const HISTORY_LIMIT = 40;
const HISTORY_CONCURRENCY = 4;

// Reports from before D39 have no talk track; they are not shown.
const Cached = z.custom<Report>(
  (v) => typeof v === "object" && v !== null && "talkTrack" in v && "tickets" in v,
);

const linksOf = (value: unknown) =>
  readJson(value, z.array(z.unknown()), []).flatMap((l) => {
    const r = IssueLinkSchema.safeParse(l);
    return r.success ? [r.data] : [];
  });

const make = Effect.gen(function* () {
  const llm = yield* Llm;
  const jira = yield* JiraClient;
  const settingsSvc = yield* Settings;
  const { q, withDb } = bindDb(yield* Db);

  const last = Effect.map(withDb(getState(CACHE_KEY)), (v) => readJson(v, Cached.nullable(), null));

  const generate = (req: ReportRequest, now = new Date()) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      const me = yield* withDb(getState(SYNC_KEYS.username));
      if (!me)
        return yield* new ReportError({
          kind: "no_user",
          message: "Sync Jira first so the report knows which work is yours.",
        });
      const { since, until, label } = reportWindow(req.period, now);
      const tracked = new Set(req.scope === "mine_and_tracked" ? settings.jira.trackedEpics : []);

      const rows = yield* q((d) =>
        d
          .select({
            key: jiraIssues.key,
            summary: jiraIssues.summary,
            issueType: jiraIssues.issueType,
            isSubtask: jiraIssues.isSubtask,
            status: jiraIssues.status,
            statusCategory: jiraIssues.statusCategory,
            assignee: jiraIssues.assignee,
            assigneeDisplay: jiraIssues.assigneeDisplay,
            reporter: jiraIssues.reporter,
            reporterDisplay: jiraIssues.reporterDisplay,
            epicKey: jiraIssues.epicKey,
            sprint: jiraIssues.sprint,
            storyPoints: jiraIssues.storyPoints,
            dueDate: jiraIssues.dueDate,
            created: jiraIssues.created,
            updated: jiraIssues.updated,
            resolved: jiraIssues.resolved,
            links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
          })
          .from(jiraIssues)
          .where(eq(jiraIssues.stale, false))
          .all(),
      );
      const issues: (RecapIssue & { assigneeDisplay: string | null })[] = rows.map(
        ({ links, ...r }) => ({
          ...r,
          blockedBy: blockInfo(linksOf(links)).blockedBy,
        }),
      );
      const inScope = (i: RecapIssue) =>
        i.assignee === me ||
        i.reporter === me ||
        (!!i.epicKey && tracked.has(i.epicKey)) ||
        tracked.has(i.key);
      const scoped = issues.filter(inScope);

      const comments = yield* q((d) =>
        d
          .select({
            issueKey: jiraComments.issueKey,
            author: jiraComments.author,
            authorDisplay: jiraComments.authorDisplay,
            created: jiraComments.created,
            body: jiraComments.body,
          })
          .from(jiraComments)
          .where(
            and(
              gte(jiraComments.created, since),
              inArray(
                jiraComments.issueKey,
                scoped.map((i) => i.key),
              ),
            ),
          )
          .all(),
      );
      comments.sort((a, b) => a.created.localeCompare(b.created));

      // Status moves and reassignments are only in Jira's history; the cache keeps
      // the latest state. A ticket whose history cannot be read keeps cache facts.
      const touched = scoped
        .filter((i) => i.updated >= since)
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, HISTORY_LIMIT);
      const results = yield* Effect.forEach(
        touched,
        (i) =>
          jira.issueHistory(i.key, since).pipe(
            Effect.either,
            Effect.map((r) => [i.key, r] as const),
          ),
        { concurrency: HISTORY_CONCURRENCY },
      );
      const history = new Map<string, readonly HistoryEntry[]>();
      const historyMissing: string[] = [];
      for (const [key, r] of results) {
        if (Either.isRight(r)) history.set(key, r.right);
        else historyMissing.push(key);
      }

      const today = localDate(now);
      const inputs = yield* withDb(loadDashboardInputs(now)).pipe(
        Effect.provideService(Settings, settingsSvc),
      );
      const dashboard = buildDashboard(inputs, settings.scoring, today, now.toISOString());
      const sprints = parseSprintState(yield* withDb(getState(SYNC_KEYS.sprints))).sprints;
      const active = sprints.filter((s) => s.state === "active");
      const mySprint =
        active.find((s) => issues.some((i) => i.sprint === s.name && i.assignee === me)) ?? null;

      // Waiting-on items and the follow-ups logged on them (FR-3).
      const deps = yield* withDb(listDependencies({}));
      const logged = deps.length
        ? yield* q((d) =>
            d
              .select()
              .from(followups)
              .where(
                inArray(
                  followups.dependencyId,
                  deps.map((x) => x.id),
                ),
              )
              .all(),
          )
        : [];
      logged.sort((a, b) => a.at.localeCompare(b.at));

      // Older asks from the dashboard, quoting the latest comment by someone else.
      const askKeys = dashboard.waitingOnMe.map((w) => w.issue.key);
      const askComments = askKeys.length
        ? yield* q((d) =>
            d
              .select({
                issueKey: jiraComments.issueKey,
                author: jiraComments.author,
                authorDisplay: jiraComments.authorDisplay,
                body: jiraComments.body,
                created: jiraComments.created,
              })
              .from(jiraComments)
              .where(inArray(jiraComments.issueKey, askKeys))
              .all(),
          )
        : [];
      // Only questions and mentions are asks; other unread comments are in the tickets.
      const asks = dashboard.waitingOnMe.flatMap((w) => {
        const latest = askComments
          .filter((c) => c.issueKey === w.issue.key && c.author !== me)
          .sort((a, b) => b.created.localeCompare(a.created))[0];
        const mentioned = w.reasons.some((r) => r.endsWith("mentioned you"));
        if (!latest || (!latest.body.includes("?") && !mentioned)) return [];
        return [
          {
            key: w.issue.key,
            who: latest.authorDisplay ?? latest.author ?? "Someone",
            what: askText(latest.body),
            at: latest.created,
          },
        ];
      });

      const facts = buildRecapFacts({
        me,
        since,
        until,
        today,
        tracked,
        activeSprints: new Set(active.map((s) => s.name)),
        sprint: mySprint,
        focus: dashboard.topFocus.map((f) => f.key),
        issues,
        comments,
        history,
        dependencies: deps.map((x) => ({
          issueKey: x.issueKey,
          label: x.label,
          owner: x.owner.name,
          externalRef: x.externalRef,
          status: x.status,
          requestedAt: x.requestedAt,
          expectedAt: x.expectedAt,
          nextFollowupAt: x.nextFollowupAt,
          followups: logged
            .filter((f) => f.dependencyId === x.id)
            .map((f) => ({ at: f.at, channel: f.channel, summary: f.summary })),
        })),
        asks,
      });
      const reportFacts: ReportFacts = {
        ...facts,
        periodLabel: label,
        since,
        today,
        outputLanguage: settings.general.outputLanguage,
      };

      let written: ReportOutput = {
        talkTrack: "Nothing to report for this period.",
        headline: "A quiet period.",
        tickets: [],
      };
      let model: string | null = null;
      if (!isQuiet(reportFacts)) {
        const r = yield* llm.object<ReportOutput>("write_report", {
          schema: buildReportSchema(facts.tickets.map((t) => t.key)),
          ...buildReportPrompt(reportFacts),
          validate: (out) => validateReport(out, reportFacts),
        });
        written = r.value;
        model = r.model;
      }
      const lines = new Map(written.tickets.map((t) => [t.key, t]));

      const report: Report = {
        generatedAt: now.toISOString(),
        since,
        until,
        periodLabel: label,
        scope: req.scope,
        talkTrack: written.talkTrack.trim(),
        headline: written.headline.trim(),
        tickets: facts.tickets.map(({ comments: _, ...t }) => ({
          ...t,
          happened: lines.get(t.key)?.happened.trim() ?? "",
          next: lines.get(t.key)?.next.trim() ?? "",
        })),
        epics: facts.epics,
        sprint: facts.sprint,
        risks: facts.risks,
        asks: facts.asks,
        stats: facts.stats,
        historyMissing,
        model,
      };
      yield* withDb(setState(CACHE_KEY, JSON.stringify(report)));
      return report;
    });

  return Reports.of({ generate: (req) => generate(req), last });
});

export const ReportsLive = Layer.effect(Reports, make);

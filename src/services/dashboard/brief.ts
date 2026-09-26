/**
 * Daily brief (FR-5.4): facts from code, prose from one `daily_brief` call,
 * cached in `sync_state` until the facts change.
 */
import { and, count, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { jiraComments, jiraIssues, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { readJson } from "@/lib/json";
import {
  type BriefFacts,
  BriefOutputSchema,
  buildBriefPrompt,
  isEmpty,
  validateBrief,
} from "@/prompts/brief";
import { query } from "@/services/db";
import { Llm } from "@/services/llm";
import { Settings, settingsOrDefault } from "@/services/settings";
import { getState, setState } from "@/services/sync/state";
import { loadDashboardInputs } from "./data";
import { buildDashboard, type Dashboard } from "./sections";

const CACHE_KEY = "brief.cache";
const CHANGE_LIMIT = 15;

const CachedBriefSchema = z.object({
  hash: z.string(),
  generatedAt: z.string(),
  sections: z.object({
    changed: z.string().default(""),
    doFirst: z.string().default(""),
    chase: z.string().default(""),
  }),
  model: z.string().nullable().default(null),
  tier: z.string().nullable().default(null),
});
export type CachedBrief = z.infer<typeof CachedBriefSchema>;

/** FNV-1a; enough to tell whether the facts changed. */
function hashFacts(value: unknown): string {
  let h = 0x811c9dc5;
  const s = JSON.stringify(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** The "since" window moves with each brief, so it is not part of the identity. */
const briefHash = (facts: BriefFacts) => hashFacts({ ...facts, since: null });

const readCache = Effect.map(getState(CACHE_KEY), (v) =>
  readJson(v, CachedBriefSchema.nullable(), null),
);

const collectFacts = (
  dashboard: Dashboard,
  since: string | null,
  today: string,
  outputLanguage: string,
) =>
  Effect.gen(function* () {
    const inScope = new Set([
      ...dashboard.topFocus.map((t) => t.key),
      ...dashboard.dueSoon.map((d) => d.key),
      ...dashboard.atRisk.map((a) => a.issue.key),
    ]);
    const changedRows = since
      ? yield* query((d) =>
          d
            .select({
              key: jiraIssues.key,
              summary: jiraIssues.summary,
              status: jiraIssues.status,
              updated: jiraIssues.updated,
            })
            .from(jiraIssues)
            .where(and(gt(jiraIssues.updated, since), eq(jiraIssues.stale, false)))
            .all(),
        )
      : [];
    const commented = since
      ? new Set(
          (yield* query((d) =>
            d
              .select({ key: jiraComments.issueKey })
              .from(jiraComments)
              .where(gt(jiraComments.created, since))
              .all(),
          )).map((r) => r.key),
        )
      : new Set<string>();
    const pending = yield* query((d) =>
      d.select({ n: count() }).from(proposals).where(eq(proposals.status, "pending")).get(),
    );
    const facts: BriefFacts = {
      today,
      since,
      outputLanguage,
      changed: changedRows
        .filter((r) => inScope.has(r.key) || commented.has(r.key))
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, CHANGE_LIMIT)
        .map((r) => ({
          key: r.key,
          summary: r.summary,
          status: r.status,
          note: commented.has(r.key) ? "new comments" : "updated",
        })),
      topFocus: dashboard.topFocus.slice(0, 5).map((t) => ({
        key: t.key,
        summary: t.summary,
        why: t.contributions.slice(0, 3).map((c) => c.reason),
      })),
      dueSoon: dashboard.dueSoon.map((d) => ({
        key: d.key,
        summary: d.summary,
        daysLeft: d.daysLeft,
      })),
      overdueDependencies: dashboard.iAmWaitingOn
        .filter((d) => d.overdueDays > 0)
        .map((d) => ({
          issueKey: d.issueKey,
          label: d.label,
          ref: d.externalRef,
          owner: d.ownerName,
          overdueDays: d.overdueDays,
        })),
      followupsDue: dashboard.iAmWaitingOn
        .filter((d) => d.followupDue)
        .map((d) => ({ issueKey: d.issueKey, label: d.label, owner: d.ownerName })),
      waitingOnMe: dashboard.waitingOnMe.map((w) => ({
        key: w.issue.key,
        summary: w.issue.summary,
        why: w.reasons[0] ?? "",
      })),
      pendingProposals: Number(pending?.n ?? 0),
    };
    return facts;
  });

/** Current dashboard, and the cached brief with whether it still matches the data. */
export const dashboardWithBrief = (now = new Date()) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const today = localDate(now);
    const inputs = yield* loadDashboardInputs(now);
    const dashboard = buildDashboard(inputs, settings.scoring, today, now.toISOString());
    const cached = yield* readCache;
    if (!cached) return { dashboard, brief: null, briefFresh: false };
    // Fresh while nothing changed since the brief and the other facts still match.
    const facts = yield* collectFacts(
      dashboard,
      cached.generatedAt,
      today,
      settings.general.outputLanguage,
    );
    return { dashboard, brief: cached, briefFresh: cached.hash === briefHash(facts) };
  });

/** Generates and caches a new brief. With nothing to report, no model call is made. */
export const generateBrief = (now = new Date()) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const today = localDate(now);
    const dashboard = buildDashboard(
      yield* loadDashboardInputs(now),
      settings.scoring,
      today,
      now.toISOString(),
    );
    const previous = yield* readCache;
    const since = previous?.generatedAt ?? new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const facts = yield* collectFacts(dashboard, since, today, settings.general.outputLanguage);
    let sections: CachedBrief["sections"];
    let model: string | null = null;
    let tier: string | null = null;
    if (isEmpty(facts)) {
      sections = {
        changed: "Nothing new since the last brief.",
        doFirst: "Nothing is urgent.",
        chase: "No one to chase.",
      };
    } else {
      const r = yield* (yield* Llm).object("daily_brief", {
        schema: BriefOutputSchema,
        ...buildBriefPrompt(facts),
        validate: (out) => validateBrief(out, facts),
      });
      sections = r.value;
      model = r.model;
      tier = r.tier;
    }
    const brief: CachedBrief = {
      // Stored as "nothing changed since now", so any later change marks it stale.
      hash: briefHash({ ...facts, changed: [] }),
      generatedAt: now.toISOString(),
      sections,
      model,
      tier,
    };
    yield* setState(CACHE_KEY, JSON.stringify(brief));
    return brief;
  });

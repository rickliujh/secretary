/**
 * Reads for the small-asks home (D44): the Settings section, the Inbox hint and
 * the Track row. Jira is only read here; writes go through the Executor.
 */
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { JiraClient } from "@/services/jira";
import { Settings, settingsOrDefault } from "@/services/settings";
import { Sync } from "@/services/sync";
import { getState, parseProjectMeta, SYNC_KEYS } from "@/services/sync/state";
import { defaultSmallAskType, isSubtaskType, smallAskTypes, unfillableFields } from "./home";

/** Projects the app knows: those of cached issues and those with stored metadata. */
export const syncedProjectKeys = Effect.gen(function* () {
  const rows = yield* query((d) =>
    d
      .selectDistinct({ key: jiraIssues.projectKey })
      .from(jiraIssues)
      .where(eq(jiraIssues.stale, false))
      .all(),
  );
  const meta = parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta));
  return [...new Set([...rows.map((r) => r.key), ...Object.keys(meta)])].sort();
});

export type SmallAskHome = {
  projectKey: string;
  label: string;
  joinActiveSprint: boolean;
  /** Types a small ask may take in the home, from Jira's project metadata; empty before a sync. */
  issueTypes: string[];
  defaultType: string | null;
};

/** The configured home, or null when none is set; `hintDismissed` for the Inbox hint. */
export const smallAskHome = Effect.gen(function* () {
  const settings = yield* settingsOrDefault(yield* Settings);
  const s = settings.smallAsks;
  if (!s.projectKey) return { home: null, hintDismissed: s.hintDismissed };
  const meta = parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta))[s.projectKey];
  const types = meta?.issueTypes ?? [];
  const home: SmallAskHome = {
    projectKey: s.projectKey,
    label: s.label,
    joinActiveSprint: s.joinActiveSprint,
    issueTypes: smallAskTypes(types),
    defaultType: defaultSmallAskType(types),
  };
  return { home, hintDismissed: s.hintDismissed };
});

export type HomeCheck = {
  projectKey: string;
  /** Standard types of the project that a small ask may take. */
  issueTypes: string[];
  defaultType: string | null;
  /** Per type: required fields the app cannot fill, so a create would fail. */
  blocked: { issueType: string; fields: string[] }[];
  /** Types whose create screen has no Labels field, so the label cannot be set. */
  noLabels: string[];
};

/** Most issue types read from the create metadata in one check. */
const MAX_TYPES = 10;

/**
 * Reads the home's create metadata (FR-10.1): which types a small ask can take
 * and which required fields the app cannot fill.
 */
export const checkHome = (projectKey: string) =>
  Effect.gen(function* () {
    const jira = yield* JiraClient;
    const { effective } = yield* (yield* Sync).fieldInfo;
    const types = yield* jira.createMetaIssueTypes(projectKey);
    const standard = types.filter(
      (t) => !t.subtask && !isSubtaskType(t.name) && smallAskTypes([t.name]).length > 0,
    );
    const blocked: HomeCheck["blocked"] = [];
    const noLabels: string[] = [];
    for (const t of standard.slice(0, MAX_TYPES)) {
      const fields = yield* jira.createMetaFields(projectKey, t.id);
      const missing = unfillableFields(
        fields,
        [effective.epicLink].filter((f): f is string => !!f),
      );
      if (missing.length) blocked.push({ issueType: t.name, fields: missing });
      if (!fields.some((f) => f.fieldId === "labels")) noLabels.push(t.name);
    }
    const names = standard.map((t) => t.name);
    return {
      projectKey,
      issueTypes: names,
      defaultType: defaultSmallAskType(names),
      blocked,
      noLabels,
    } satisfies HomeCheck;
  });

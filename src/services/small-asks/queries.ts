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
import { checkCreateFields, defaultSmallAskType, knownSubtaskTypes, smallAskTypes } from "./home";

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
  /** Sub-task types Jira flags across the synced projects; null when not known (older metadata). */
  subtaskTypes: string[] | null;
};

/** The configured home, or null when none is set; `hintDismissed` for the Inbox hint. */
export const smallAskHome = Effect.gen(function* () {
  const settings = yield* settingsOrDefault(yield* Settings);
  const s = settings.smallAsks;
  if (!s.projectKey) return { home: null, hintDismissed: s.hintDismissed };
  const all = parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta));
  const meta = all[s.projectKey];
  const types = meta?.issueTypes ?? [];
  const subtasks = meta?.subtaskTypes ?? null;
  const home: SmallAskHome = {
    projectKey: s.projectKey,
    label: s.label,
    joinActiveSprint: s.joinActiveSprint,
    issueTypes: smallAskTypes(types, subtasks),
    defaultType: defaultSmallAskType(types, subtasks),
    subtaskTypes: knownSubtaskTypes(all),
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
  /** Per type: required fields filled only when the model gives a value; an ask without one fails. */
  needed: { issueType: string; fields: string[] }[];
  /** Per type: Labels, Assignee or Description missing from the create screen, so they are not set. */
  notOnScreen: { issueType: string; fields: string[] }[];
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
    // Jira's own sub-task flag decides, not the name.
    const subtasks = types.filter((t) => t.subtask).map((t) => t.name);
    const standard = types.filter((t) => smallAskTypes([t.name], subtasks).length > 0);
    const blocked: HomeCheck["blocked"] = [];
    const needed: HomeCheck["needed"] = [];
    const notOnScreen: HomeCheck["notOnScreen"] = [];
    for (const t of standard.slice(0, MAX_TYPES)) {
      const fields = yield* jira.createMetaFields(projectKey, t.id);
      const c = checkCreateFields(fields, effective.epicLink);
      if (c.unfillable.length) blocked.push({ issueType: t.name, fields: c.unfillable });
      if (c.whenGiven.length) needed.push({ issueType: t.name, fields: c.whenGiven });
      if (c.notOnScreen.length) notOnScreen.push({ issueType: t.name, fields: c.notOnScreen });
    }
    const names = standard.map((t) => t.name);
    return {
      projectKey,
      issueTypes: names,
      defaultType: defaultSmallAskType(names, subtasks),
      blocked,
      needed,
      notOnScreen,
    } satisfies HomeCheck;
  });

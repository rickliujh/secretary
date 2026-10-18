/** Test wiring for the work model: the in-memory Db, settings, scripted models and the real Llm. */
import { Effect, Layer } from "effect";
import { jiraIssues } from "@/db/schema";
import { type Db, query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import type { Llm } from "@/services/llm";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels, type Scripted } from "@/services/llm/test";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import type { Settings } from "@/services/settings";
import { type AppSettings, defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { SYNC_KEYS, setState } from "@/services/sync/state";
import { testProvider } from "./helpers";

export const SPRINT = "Payments 15";

/** fast -> "fast-m", standard -> "std-m", no strong tier. */
export function workTestLayer(
  scripts: Record<string, Scripted[]> = {},
  patch: Partial<AppSettings> = {},
) {
  const models = makeScriptedModels(scripts);
  const deps = Layer.mergeAll(
    makeSettingsTest({
      ...defaultSettings(),
      providers: [testProvider],
      tiers: {
        fast: { providerId: "p1", model: "fast-m" },
        standard: { providerId: "p1", model: "std-m" },
        strong: null,
      },
      ...patch,
    }),
    makeSecretsTest({ [secretNames.providerApiKey("p1")]: "key" }),
    DbTest,
    models.layer,
  );
  const layer = Layer.provideMerge(LlmLive, deps);
  const run = <A, E>(program: Effect.Effect<A, E, Llm | Db | Settings>) =>
    Effect.runPromise(Effect.provide(program, layer));
  return { layer, models, run };
}

type IssueInsert = typeof jiraIssues.$inferInsert;

/** A cached ticket of the user's in the active sprint, in progress, unless patched. */
export const issue = (key: string, patch: Partial<IssueInsert> = {}): IssueInsert => ({
  key,
  id: key.replace(/\D/g, "") || "1",
  projectKey: key.split("-")[0] ?? "PAY",
  issueType: "Story",
  summary: `Ticket ${key}`,
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: "me",
  assigneeDisplay: "Me",
  sprint: SPRINT,
  created: "2026-10-01T09:00:00.000Z",
  updated: "2026-10-10T09:00:00.000Z",
  syncedAt: "2026-10-10T09:00:00.000Z",
  raw: {},
  ...patch,
});

/** "key is blocked by blocker", as Jira embeds it in `issuelinks`. */
export const blockedByLink = (
  blocker: string,
  category = "indeterminate",
  status = "In Progress",
) => ({
  id: `l-${blocker}`,
  type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
  inwardIssue: {
    key: blocker,
    fields: {
      summary: `Ticket ${blocker}`,
      status: { name: status, statusCategory: { key: category } },
    },
  },
});

/** The signed-in user ("me") and an active sprint, as sync stores them. */
export const seedSyncState = Effect.gen(function* () {
  yield* setState(SYNC_KEYS.username, "me");
  yield* setState(
    SYNC_KEYS.sprints,
    JSON.stringify({
      sprints: [
        {
          id: 15,
          name: SPRINT,
          state: "active",
          boardId: 1,
          start: "2026-10-05",
          end: "2026-10-16",
        },
      ],
      completeBoards: [],
      boardProjects: {},
    }),
  );
});

export const insertIssues = (rows: readonly IssueInsert[]) =>
  query((d) => d.insert(jiraIssues).values([...rows]));

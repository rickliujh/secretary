/** Full intake stack for tests: fixture-synced Jira cache, scripted models, real services. */
import { Layer } from "effect";
import { ChatLive } from "@/services/chat/live";
import { CommsLive } from "@/services/comms/live";
import { ConfluenceClientLive } from "@/services/confluence/live";
import { IntakeLive } from "@/services/intake/live";
import { LearningLive } from "@/services/learning/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels, type Scripted } from "@/services/llm/test";
import { PlanningLive } from "@/services/planning/live";
import { ReportsLive } from "@/services/report/live";
import { RetrievalLive } from "@/services/retrieval/live";
import type { DataSource } from "@/services/settings/schema";
import { SourcesLive } from "@/services/sources/live";
import { type MemoryVaults, makeObsidianCliTest } from "@/services/sources/test";
import { testProvider } from "./helpers";
import { syncedJiraLayer } from "./seed";
import type { StubRoute } from "./stub-fetch";

/** fast -> "fast-m", standard -> "std-m", no strong tier (so no escalation). */
export function intakeTestLayer(
  scripts: Record<string, Scripted[]>,
  extraRoutes: StubRoute[] = [],
  opts: { vaults?: MemoryVaults; dataSources?: DataSource[] } = {},
) {
  const jira = syncedJiraLayer(extraRoutes, {
    dataSources: opts.dataSources ?? [],
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
  });
  const models = makeScriptedModels(scripts);
  const llm = Layer.provideMerge(
    Layer.merge(LlmLive, ConfluenceClientLive),
    Layer.merge(jira.layer, models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.mergeAll(CommsLive, LearningLive, ChatLive, PlanningLive, ReportsLive),
    Layer.provideMerge(
      IntakeLive,
      Layer.provideMerge(
        Layer.merge(
          RetrievalLive,
          SourcesLive.pipe(Layer.provide(makeObsidianCliTest(opts.vaults).layer)),
        ),
        llm,
      ),
    ),
  );
  return { layer, models, seen: jira.seen };
}

export const out = (value: unknown) => ({ text: JSON.stringify(value) });

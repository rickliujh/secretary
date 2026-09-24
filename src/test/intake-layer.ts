/** Full intake stack for tests: fixture-synced Jira cache, scripted models, real services. */
import { Layer } from "effect";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels, type Scripted } from "@/services/llm/test";
import { RetrievalLive } from "@/services/retrieval/live";
import { ProviderSchema } from "@/services/settings/schema";
import { syncedJiraLayer } from "./seed";
import type { StubRoute } from "./stub-fetch";

export const testProvider = ProviderSchema.parse({
  id: "p1",
  name: "Test",
  kind: "anthropic",
  baseUrl: "https://llm.test/v1",
});

/** fast -> "fast-m", standard -> "std-m", no strong tier (so no escalation). */
export function intakeTestLayer(
  scripts: Record<string, Scripted[]>,
  extraRoutes: StubRoute[] = [],
) {
  const jira = syncedJiraLayer(extraRoutes, {
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
  });
  const models = makeScriptedModels(scripts);
  const llm = Layer.provideMerge(LlmLive, Layer.merge(jira.layer, models.layer));
  const layer = Layer.provideMerge(IntakeLive, Layer.provideMerge(RetrievalLive, llm));
  return { layer, models, seen: jira.seen };
}

export const out = (value: unknown) => ({ text: JSON.stringify(value) });

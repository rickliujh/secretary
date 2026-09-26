/**
 * The single Effect runtime for the webview (design.md section 3).
 * React calls `run` inside TanStack Query functions.
 */
import { Cause, type Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ChatLive } from "@/services/chat/live";
import { CommsLive } from "@/services/comms/live";
import { ConfluenceClientLive } from "@/services/confluence/live";
import { DbLive } from "@/services/db/live";
import { ExecutorLive } from "@/services/executor/live";
import { FetcherLive } from "@/services/http";
import { IntakeLive } from "@/services/intake/live";
import { JiraClientLive } from "@/services/jira/live";
import { LearningLive } from "@/services/learning/live";
import { LlmLive, ModelFactoryLive } from "@/services/llm/live";
import { PlanningLive } from "@/services/planning/live";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { SecretsLive } from "@/services/secrets/live";
import { SettingsLive } from "@/services/settings/live";
import { SyncLive } from "@/services/sync/live";

const Base = FetcherLive.pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsLive, SecretsLive, DbLive)),
);

// Chat's propose_actions tool runs intake, so Chat sits above it.
const AppLayer = ChatLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(IntakeLive, ProposalsLive, CommsLive, LearningLive, PlanningLive),
  ),
  Layer.provideMerge(Layer.mergeAll(RetrievalLive, ExecutorLive)),
  Layer.provideMerge(SyncLive),
  Layer.provideMerge(Layer.mergeAll(LlmLive, JiraClientLive, ConfluenceClientLive)),
  Layer.provideMerge(ModelFactoryLive),
  Layer.provideMerge(Base),
);

export const runtime = ManagedRuntime.make(AppLayer);

export type AppServices = ManagedRuntime.ManagedRuntime.Context<typeof runtime>;

/**
 * Runs a program and rejects with its typed error (not a FiberFailure), so
 * query error handlers can inspect `_tag`. Aborting `signal` interrupts it.
 */
export async function run<A, E>(
  program: Effect.Effect<A, E, AppServices>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await runtime.runPromiseExit(program, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Started once per app launch; used for the session token total. */
export const SESSION_STARTED_AT = new Date().toISOString();

/**
 * Pure tier and task resolution (design.md section 7.1, decision D13).
 */
import type { AppSettings, Provider, TierBinding, TierBindings } from "@/services/settings/schema";
import { TASK_DEFAULTS, type TaskType, TIERS, type Tier } from "./tasks";

export type ResolvedTier = { tier: Tier; binding: TierBinding };

export type TaskRoute = {
  task: TaskType;
  /** Tier the task asks for after user overrides. */
  requestedTier: Tier;
  /** Configured tier actually used, or undefined when no tier is configured. */
  resolved: ResolvedTier | undefined;
  escalate: boolean;
  confidenceThreshold: number;
  timeoutMs: number;
};

/** Looks for the wanted tier, then stronger tiers, then weaker ones. */
export function resolveTier(tiers: TierBindings, wanted: Tier): ResolvedTier | undefined {
  const i = TIERS.indexOf(wanted);
  const order = [...TIERS.slice(i), ...TIERS.slice(0, i).reverse()];
  for (const tier of order) {
    const binding = tiers[tier];
    if (binding) return { tier, binding };
  }
  return undefined;
}

export function resolveTask(
  settings: Pick<AppSettings, "tiers" | "taskOverrides">,
  task: TaskType,
): TaskRoute {
  const defaults = TASK_DEFAULTS[task];
  const override = settings.taskOverrides[task] ?? {};
  const requestedTier = override.tier ?? defaults.tier;
  return {
    task,
    requestedTier,
    resolved: resolveTier(settings.tiers, requestedTier),
    escalate: override.escalate ?? defaults.escalate,
    confidenceThreshold: defaults.confidenceThreshold,
    timeoutMs: defaults.timeoutMs,
  };
}

const sameBinding = (a: TierBinding, b: TierBinding) =>
  a.providerId === b.providerId && a.model === b.model;

/** Next stronger configured tier that uses a different model, if any. */
export function escalationTarget(
  tiers: TierBindings,
  current: ResolvedTier,
): ResolvedTier | undefined {
  for (const tier of TIERS.slice(TIERS.indexOf(current.tier) + 1)) {
    const binding = tiers[tier];
    if (binding && !sameBinding(binding, current.binding)) return { tier, binding };
  }
  return undefined;
}

export function findProvider(providers: readonly Provider[], id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

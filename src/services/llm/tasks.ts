/**
 * LLM task types and their default routing (design.md section 7.1).
 * Callers name a task; the `Llm` service picks the tier and model.
 */

export const TIERS = ["fast", "standard", "strong"] as const;
export type Tier = (typeof TIERS)[number];

export const TASK_TYPES = [
  "segment_input",
  "rerank_candidates",
  "classify_item",
  "route_reply",
  "plan_sprint",
  "extract_profile_facts",
  "summarize",
  "draft_message",
  "daily_brief",
  "consolidate_rules",
  "chat",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Internal tasks: accounted in `llm_calls`, not user-routable. */
export type InternalTask = "repair_output" | "test_connection";

export type TaskDefaults = {
  tier: Tier;
  escalate: boolean;
  /** Confidence below this triggers escalation when the caller reports confidence. */
  confidenceThreshold: number;
  timeoutMs: number;
  label: string;
  description: string;
};

export const TASK_DEFAULTS: Record<TaskType, TaskDefaults> = {
  segment_input: {
    tier: "fast",
    escalate: true,
    confidenceThreshold: 0.5,
    timeoutMs: 60_000,
    label: "Segment input",
    description: "Split a long paste into atomic items",
  },
  rerank_candidates: {
    tier: "fast",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 45_000,
    label: "Rerank candidates",
    description: "Order retrieved tickets for one item",
  },
  classify_item: {
    tier: "standard",
    escalate: true,
    confidenceThreshold: 0.6,
    timeoutMs: 120_000,
    label: "Classify item",
    description: "Turn one item into candidate-constrained proposals",
  },
  route_reply: {
    tier: "fast",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 45_000,
    label: "Route reply",
    description: "Pick which items of a thread a follow-up is about",
  },
  plan_sprint: {
    tier: "standard",
    escalate: true,
    confidenceThreshold: 0,
    timeoutMs: 180_000,
    label: "Plan sprint",
    description: "Choose the next sprint's work from the candidates",
  },
  extract_profile_facts: {
    tier: "fast",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 45_000,
    label: "Extract profile facts",
    description: "Personality and title cues about a contact",
  },
  summarize: {
    tier: "fast",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 60_000,
    label: "Summarize",
    description: "Comment threads and long descriptions",
  },
  draft_message: {
    tier: "standard",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 120_000,
    label: "Draft message",
    description: "Teams messages and emails",
  },
  daily_brief: {
    tier: "standard",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 120_000,
    label: "Daily brief",
    description: "Prose summary of what matters now",
  },
  consolidate_rules: {
    tier: "strong",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 180_000,
    label: "Consolidate rules",
    description: "Generalise correction examples into rules",
  },
  chat: {
    tier: "standard",
    escalate: false,
    confidenceThreshold: 0,
    timeoutMs: 180_000,
    label: "Chat",
    description: "Ask the secretary",
  },
};

/** Model suggestions shown in settings for Anthropic providers. */
export const ANTHROPIC_MODEL_SUGGESTIONS: Record<Tier, string> = {
  fast: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  strong: "claude-opus-5-5",
};

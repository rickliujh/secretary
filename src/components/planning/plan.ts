/**
 * The Planning page's own logic (design.md D30): how the reviewed plan is
 * ordered before it is proposed, and how full the sprint looks.
 */

import type { Tone } from "@/components/tone";
import { addBusinessDays, localDateOf } from "@/lib/dates";
import { CAPACITY_SLACK } from "@/prompts/plan";
import type { CandidateGroup, PlanPrep, PlanToPropose } from "@/services/planning";

export const GROUP_ORDER: readonly CandidateGroup[] = [
  "carry_over",
  "planned",
  "backlog",
  "pickup",
];

export const GROUP_LABELS: Record<CandidateGroup, string> = {
  carry_over: "Unfinished this sprint",
  planned: "Already in the next sprint",
  backlog: "Your backlog",
  pickup: "Unassigned under tracked epics",
};

type Reasoned = { key: string; reason: string };

/**
 * The checked keys to propose: the model's picks in its order (most important
 * first), then anything the user added, in the order the candidates are listed.
 */
export function orderPicks(
  modelPicks: readonly string[],
  checked: ReadonlySet<string>,
  candidateKeys: readonly string[],
): string[] {
  const fromModel = modelPicks.filter((k) => checked.has(k));
  const seen = new Set(fromModel);
  const added = candidateKeys.filter((k) => checked.has(k) && !seen.has(k));
  return [...fromModel, ...added];
}

/** The reviewed plan: deferrals the user overrode by checking the issue are dropped. */
export function toProposal(opts: {
  goal: string;
  checked: ReadonlySet<string>;
  candidateKeys: readonly string[];
  plan: { picks: readonly Reasoned[]; deferred: readonly Reasoned[]; risks: readonly string[] };
}): PlanToPropose {
  const { goal, checked, candidateKeys, plan } = opts;
  return {
    goal: goal.trim(),
    picks: orderPicks(
      plan.picks.map((p) => p.key),
      checked,
      candidateKeys,
    ),
    deferred: plan.deferred.filter((d) => !checked.has(d.key)),
    risks: [...plan.risks],
  };
}

/** The capacity field's text as points; empty or unreadable means unknown. */
export function parseCapacity(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * How full the sprint is: over capacity is a warning, over the slack the
 * model is held to (rounded the same way) is a danger.
 */
export function capacityTone(points: number, capacity: number | null): Tone {
  if (capacity === null) return "neutral";
  const limit = Math.round(capacity * CAPACITY_SLACK * 10) / 10;
  if (points > limit) return "danger";
  if (points > capacity) return "warning";
  return "success";
}

/** The capacity bar's fill, 0 to 100. */
export const capacityPercent = (points: number, capacity: number | null) =>
  capacity === null || capacity <= 0 ? 0 : Math.min(100, Math.round((points / capacity) * 100));

/**
 * Whether the dashboard should suggest planning: the ending sprint closes
 * within two working days, or has already closed and the next sprint exists.
 */
export function planningDue(
  prep: Pick<PlanPrep, "ending" | "next">,
  today: string,
): prep is Pick<PlanPrep, "next"> & { ending: NonNullable<PlanPrep["ending"]> } {
  const end = prep.ending?.end ? localDateOf(prep.ending.end) : null;
  if (!end) return false;
  if (end < today) return prep.next !== null;
  return end <= addBusinessDays(today, 2);
}

/** The success toast after proposing. */
export function proposedMessage(r: { proposals: number; alreadyThere: string[] }) {
  const moves =
    r.proposals === 0
      ? "Nothing to move"
      : `${r.proposals} move${r.proposals === 1 ? "" : "s"} to approve`;
  if (r.alreadyThere.length === 0) return moves;
  const n = r.alreadyThere.length;
  return `${moves}; ${r.alreadyThere.join(", ")} ${n === 1 ? "was" : "were"} already in the sprint`;
}

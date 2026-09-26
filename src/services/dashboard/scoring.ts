/**
 * Deterministic, explainable ranking for Top focus (FR-5.2, design.md 7.3
 * "Scoring"). Each factor is scaled to 0..1, multiplied by its weight, and the
 * user's local override is added. Reasons explain every non-zero factor.
 */
import { daysBetween } from "@/lib/dates";
import type { ScoringWeights } from "@/services/settings/schema";

export type ScoreInput = {
  key: string;
  priority: string | null;
  dueDate: string | null;
  updated: string;
  statusName: string;
  /** Unresolved issues this one is blocked by (from issue links). */
  blockedBy: string[];
  /** Unresolved issues this one blocks. */
  blocks: string[];
  /** Open dependencies: most overdue first. */
  dependencies: {
    label: string;
    externalRef: string | null;
    overdueDays: number;
    status: string;
  }[];
  pinned: boolean;
  /** Local priority override, added to the score as is. */
  override: number | null;
};

export type Factor = keyof ScoringWeights | "override";
export type Contribution = { factor: Factor; value: number; points: number; reason: string };
export type Scored = { key: string; score: number; contributions: Contribution[] };

const PRIORITY_VALUE: Record<string, number> = {
  blocker: 1,
  highest: 1,
  critical: 0.85,
  high: 0.75,
  major: 0.6,
  medium: 0.5,
  minor: 0.3,
  low: 0.25,
  lowest: 0.1,
  trivial: 0.1,
};

export function priorityValue(priority: string | null): number {
  if (!priority) return 0.4;
  return PRIORITY_VALUE[priority.toLowerCase()] ?? 0.4;
}

/** 1 when due today or overdue, falling to 0 two weeks out. */
export function dueValue(
  dueDate: string | null,
  today: string,
): { value: number; daysLeft: number | null } {
  if (!dueDate) return { value: 0, daysLeft: null };
  const left = daysBetween(today, dueDate);
  return { value: left <= 0 ? 1 : Math.max(0, 1 - left / 14), daysLeft: left };
}

/** 0 for work touched in the last week, rising to 1 at 30 days without updates. */
export function staleValue(updated: string, today: string): { value: number; idle: number } {
  const idle = Math.max(0, daysBetween(updated, today));
  return { value: Math.min(1, Math.max(0, (idle - 7) / 23)), idle };
}

const BLOCKED_STATUS = /block|on hold|waiting|impeded/i;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function scoreIssue(input: ScoreInput, w: ScoringWeights, today: string): Scored {
  const c: Contribution[] = [];
  const add = (factor: Factor, value: number, weight: number, reason: string) => {
    if (value > 0 && weight !== 0) c.push({ factor, value, points: value * weight, reason });
  };

  const pri = priorityValue(input.priority);
  add("priority", pri, w.priority, `${input.priority ?? "No"} priority`);

  const due = dueValue(input.dueDate, today);
  if (due.daysLeft !== null) {
    add(
      "due",
      due.value,
      w.due,
      due.daysLeft < 0
        ? `${plural(-due.daysLeft, "day")} overdue`
        : due.daysLeft === 0
          ? "Due today"
          : `Due in ${plural(due.daysLeft, "day")}`,
    );
  }

  const statusBlocked = BLOCKED_STATUS.test(input.statusName);
  const depBlocked = input.dependencies.some((d) => d.status === "blocked");
  if (input.blockedBy.length || statusBlocked || depBlocked) {
    add(
      "blocked",
      1,
      w.blocked,
      input.blockedBy.length
        ? `Blocked by ${input.blockedBy.slice(0, 3).join(", ")}`
        : statusBlocked
          ? `Status is ${input.statusName}`
          : "A dependency is blocked",
    );
  }
  if (input.blocks.length) {
    add(
      "blocking",
      Math.min(1, input.blocks.length / 3),
      w.blocking,
      `Blocks ${input.blocks.slice(0, 3).join(", ")}`,
    );
  }

  const stale = staleValue(input.updated, today);
  add("stale", stale.value, w.stale, `No updates for ${plural(stale.idle, "day")}`);

  const worst = input.dependencies[0];
  if (worst && worst.overdueDays > 0) {
    add(
      "dependency",
      Math.min(1, worst.overdueDays / 7),
      w.dependency,
      `Waiting on ${worst.label}${worst.externalRef ? ` (${worst.externalRef})` : ""}, ${plural(worst.overdueDays, "day")} overdue`,
    );
  }

  if (input.pinned) add("pinned", 1, w.pinned, "Pinned");
  if (input.override) {
    c.push({
      factor: "override",
      value: input.override,
      points: input.override,
      reason: `Your adjustment ${input.override > 0 ? "+" : ""}${input.override}`,
    });
  }

  c.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return {
    key: input.key,
    score: Math.round(c.reduce((s, x) => s + x.points, 0) * 100) / 100,
    contributions: c,
  };
}

/** Highest score first; ties by key for a stable order. */
export function rank(inputs: readonly ScoreInput[], w: ScoringWeights, today: string): Scored[] {
  return inputs
    .map((i) => scoreIssue(i, w, today))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

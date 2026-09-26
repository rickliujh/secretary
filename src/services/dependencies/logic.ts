/**
 * Pure dependency logic (FR-3): overdue days, follow-up dates, grouping and
 * ordering for the Waiting page. Dates are local calendar dates (YYYY-MM-DD).
 */
import { daysBetween, localDateOf } from "@/lib/dates";

/** Kept here for the components that schedule follow-ups. */
export { addBusinessDays } from "@/lib/dates";

export type DependencyStatus = "open" | "waiting" | "blocked" | "resolved";

export type DependencyTiming = {
  /** Days past the expected date; 0 when not overdue or resolved. */
  overdueDays: number;
  /** True when the next follow-up date is today or earlier. */
  followupDue: boolean;
  /** Days since the follow-up fell due (0 when due today). */
  followupLateDays: number;
};

export function timing(
  dep: { status: DependencyStatus; expectedAt: string | null; nextFollowupAt: string | null },
  today: string,
): DependencyTiming {
  if (dep.status === "resolved") return { overdueDays: 0, followupDue: false, followupLateDays: 0 };
  const overdue = dep.expectedAt ? daysBetween(dep.expectedAt, today) : 0;
  const late = dep.nextFollowupAt ? daysBetween(dep.nextFollowupAt, today) : -1;
  return {
    overdueDays: Math.max(0, overdue),
    followupDue: late >= 0,
    followupLateDays: Math.max(0, late),
  };
}

export type OwnerRef = { type: "person" | "team" | "none"; id: string | null; name: string };

export type Groupable = {
  id: string;
  status: DependencyStatus;
  expectedAt: string | null;
  nextFollowupAt: string | null;
  owner: OwnerRef;
};

export type Group<T> = {
  owner: OwnerRef;
  items: (T & { timing: DependencyTiming })[];
  maxOverdue: number;
  due: number;
};

/** Groups by owner; groups and items are ordered most overdue first (FR-3.3). */
export function groupByOwner<T extends Groupable>(deps: readonly T[], today: string): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const d of deps) {
    const key = `${d.owner.type}:${d.owner.id ?? d.owner.name}`;
    const g = groups.get(key) ?? { owner: d.owner, items: [], maxOverdue: 0, due: 0 };
    const t = timing(d, today);
    g.items.push({ ...d, timing: t });
    g.maxOverdue = Math.max(g.maxOverdue, t.overdueDays);
    if (t.followupDue) g.due++;
    groups.set(key, g);
  }
  const itemOrder = (a: Group<T>["items"][number], b: Group<T>["items"][number]) =>
    Number(a.status === "resolved") - Number(b.status === "resolved") ||
    b.timing.overdueDays - a.timing.overdueDays ||
    Number(b.timing.followupDue) - Number(a.timing.followupDue) ||
    (a.expectedAt ?? "9999").localeCompare(b.expectedAt ?? "9999");
  return [...groups.values()]
    .map((g) => ({ ...g, items: g.items.sort(itemOrder) }))
    .sort(
      (a, b) =>
        b.maxOverdue - a.maxOverdue || b.due - a.due || a.owner.name.localeCompare(b.owner.name),
    );
}

/**
 * URL for a Jira remote link. Jira requires one: the dependency's own URL,
 * else the owning team's first Confluence page, else a mailto for the person.
 */
export function mirrorUrl(
  dep: { externalUrl: string | null },
  owner: { teamUrls?: readonly string[]; personEmail?: string | null },
): string | null {
  return (
    dep.externalUrl ||
    owner.teamUrls?.[0] ||
    (owner.personEmail ? `mailto:${owner.personEmail}` : null)
  );
}

export const mirrorGlobalId = (dependencyId: string) => `secretary:dependency:${dependencyId}`;

/** Notes for a chase draft request, grounded in the dependency (FR-6 AC). */
export function chaseNotes(dep: {
  label: string;
  externalRef: string | null;
  issueKey: string;
  requestedAt: string | null;
  expectedAt: string | null;
}): string {
  return [
    `Chase ${dep.label}${dep.externalRef ? ` (${dep.externalRef})` : ""} for ${dep.issueKey}.`,
    dep.requestedAt ? `First requested on ${localDateOf(dep.requestedAt)}.` : null,
    dep.expectedAt ? `Was expected by ${dep.expectedAt}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

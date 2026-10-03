/**
 * Pure dependency logic (FR-3): overdue days, follow-up dates, grouping and
 * ordering for the Waiting page. Dates are local calendar dates (YYYY-MM-DD).
 */
import { addBusinessDays, daysBetween, localDateOf } from "@/lib/dates";

/** Kept here for the components that schedule follow-ups. */
export { addBusinessDays } from "@/lib/dates";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DependencyStatus = "open" | "waiting" | "blocked" | "resolved";

export type DependencyTiming = {
  /** Days past the expected date; 0 when not overdue, resolved or asleep. */
  overdueDays: number;
  /** True when the next follow-up date is today or earlier, or the owner is back (D47). */
  followupDue: boolean;
  /** Days since the follow-up fell due (0 when due today). */
  followupLateDays: number;
  /**
   * The owner is away (D47): not overdue, no follow-up due, no reminder, no score.
   * Today lists sleeping waits last.
   */
  asleep: boolean;
  /** The owner's last day away while the wait sleeps; else null. */
  awayUntil: string | null;
  /**
   * The first working day the owner is back, while no follow-up has been logged
   * since; else null. The follow-up is due from that day ("<name> is back").
   */
  backSince: string | null;
  /** When the next follow-up falls due: the day the owner is back while asleep or back, else `nextFollowupAt`. */
  followupOn: string | null;
  /** "Bob is away until 14 Oct" while asleep, "Bob is back" once back; else null. */
  reason: string | null;
};

/** A person owner's away date (D47). Team-owned waits have none. */
export type OwnerAway = { name: string; awayUntil: string };

export type TimingInput = {
  status: DependencyStatus;
  expectedAt: string | null;
  nextFollowupAt: string | null;
  /** When the wait was opened (ISO time); a wait opened after the owner came back is not "back". */
  requestedAt?: string | null;
  /** The newest follow-up logged (ISO time); one logged since the owner came back ends "is back". */
  lastFollowupAt?: string | null;
  /** The owner's away date, for person owners only. */
  ownerAway?: OwnerAway | null;
};

/** "14 Oct" for a YYYY-MM-DD date. */
const dayMonth = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** The first working day after an away date: when the owner is back (D47). */
export const backOn = (awayUntil: string) => addBusinessDays(awayUntil, 1);

/**
 * Overdue and follow-up state of a wait on `today`, with the owner's away date
 * (D47): while the owner is away the wait sleeps; from the first working day
 * after, its follow-up is due with the reason "<name> is back" until a follow-up
 * is logged. A wait opened after the owner came back, or a past date with a
 * follow-up since, is timed as usual, so an old date never needs clearing.
 */
export function timing(dep: TimingInput, today: string): DependencyTiming {
  const none = { asleep: false, awayUntil: null, backSince: null, reason: null };
  if (dep.status === "resolved")
    return {
      overdueDays: 0,
      followupDue: false,
      followupLateDays: 0,
      followupOn: null,
      ...none,
    };
  const away = dep.ownerAway;
  if (away && ISO_DATE.test(away.awayUntil)) {
    const back = backOn(away.awayUntil);
    if (today < back)
      return {
        overdueDays: 0,
        followupDue: false,
        followupLateDays: 0,
        asleep: true,
        awayUntil: away.awayUntil,
        backSince: null,
        followupOn: back,
        reason: `${away.name} is away until ${dayMonth(away.awayUntil)}`,
      };
    const openedBefore = !dep.requestedAt || localDateOf(dep.requestedAt) < back;
    const chasedSince = !!dep.lastFollowupAt && localDateOf(dep.lastFollowupAt) >= back;
    if (openedBefore && !chasedSince) {
      const overdue = dep.expectedAt ? daysBetween(dep.expectedAt, today) : 0;
      return {
        overdueDays: Math.max(0, overdue),
        followupDue: true,
        followupLateDays: Math.max(0, daysBetween(back, today)),
        asleep: false,
        awayUntil: null,
        backSince: back,
        followupOn: back,
        reason: `${away.name} is back`,
      };
    }
  }
  const overdue = dep.expectedAt ? daysBetween(dep.expectedAt, today) : 0;
  const late = dep.nextFollowupAt ? daysBetween(dep.nextFollowupAt, today) : -1;
  return {
    overdueDays: Math.max(0, overdue),
    followupDue: late >= 0,
    followupLateDays: Math.max(0, late),
    followupOn: dep.nextFollowupAt,
    ...none,
  };
}

/**
 * The next follow-up after a reply or a new date (D46): the one asked for, else
 * the first working day after a new expected date, else the default chase
 * interval (undefined, so `logFollowup` applies its setting).
 */
export function nextFollowupAfter(p: {
  nextFollowupAt: string | null;
  expectedAt: string | null;
}): string | undefined {
  if (p.nextFollowupAt) return p.nextFollowupAt;
  if (p.expectedAt) return addBusinessDays(p.expectedAt, 1);
  return undefined;
}

export type OwnerRef = { type: "person" | "team" | "none"; id: string | null; name: string };

export type Groupable = TimingInput & {
  id: string;
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
  // Resolved last, sleeping ones (owner away) just before them (D47).
  const itemOrder = (a: Group<T>["items"][number], b: Group<T>["items"][number]) =>
    Number(a.status === "resolved") - Number(b.status === "resolved") ||
    Number(a.timing.asleep) - Number(b.timing.asleep) ||
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

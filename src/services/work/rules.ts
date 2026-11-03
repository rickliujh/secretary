/**
 * Consequence rules (FR-19.6, D61, Phase 25), pure. When an event changes a
 * fact, each rule works out what else is now stale and returns situations: a
 * title, the facts in one line, and the steps that would set it right, each a
 * canonical proposal payload (`ProposalPayloadSchema`), so validation, editing,
 * revoke and the Executor need nothing new.
 *
 * No model call anywhere: step texts are templates filled from the facts, and
 * words that need writing (a message to a person) are `draft_message` steps the
 * Drafts page writes later. A situation's key fingerprints the facts it used,
 * so the same situation is offered once and a changed fact makes a new one.
 */

import type { WaitData } from "@/db/schema";
import { addBusinessDays, localDateOf } from "@/lib/dates";
import {
  chaseNotes,
  nextFollowupAfter,
  type OwnerAway,
  timing,
} from "@/services/dependencies/logic";
import {
  type ProposalPayload,
  ProposalPayloadSchema,
  type StoredProposalPayload,
} from "@/services/proposals/schema";
import { type AppSettings, RULE_NAMES, type RuleName } from "@/services/settings/schema";
import type { FactTicket, ItemFacts } from "./facts";
import {
  eventData,
  type PlaybookName,
  type Situation,
  type SituationKind,
  type StepDraft,
  type WorkState,
} from "./schema";

export { RULE_NAMES, type RuleName };

/** What each rule is called, and what it offers, in Settings and the Work tab. */
export const RULE_LABELS: Record<RuleName, { name: string; offers: string }> = {
  expected_date_moved: {
    name: "an expected date moved",
    offers:
      "Moves the wait to the new date, due dates that are now too early, and drafts a note to whoever you promised an ETA.",
  },
  blocker_closed: {
    name: "a blocker closed",
    offers:
      "Moves the waiting ticket back to in progress, says so on it, and resolves the wait on the blocker.",
  },
  commitment_due: {
    name: "a promise is due",
    offers: "Drafts a message to the person you promised, on the day or once it is late.",
  },
  teammate_touched: {
    name: "someone commented on your ticket",
    offers: "A reminder to read it, with a reply draft when they ask you something.",
  },
  wait_unanswered: {
    name: "a wait went unanswered",
    offers:
      "Drafts a chase once the follow-up date comes, sets the next one, and says on your ticket that you still wait.",
  },
  ticket_done: {
    name: "you finished a ticket",
    offers:
      "Resolves what it still waited on, notes on it who asked and when, and drafts a note to them for a small ask.",
  },
};

/** The playbooks that are no rule (Phase 26), as cards and bundles name them. */
export const PLAYBOOK_LABELS: Record<PlaybookName, { name: string; offers: string }> = {
  waiting_on_someone: {
    name: "you are waiting on someone",
    offers:
      "Tracks the wait, links their ticket, says so on yours, and prepares the request, as your standing instructions say.",
  },
  wait_resolved: {
    name: "a wait is over",
    offers: "Resolves the wait, says so on the ticket, and moves it out of Blocked.",
  },
};

/** The label of any card or bundle: a rule's or a playbook's. */
export const SITUATION_LABELS: Record<SituationKind, { name: string; offers: string }> = {
  ...RULE_LABELS,
  ...PLAYBOOK_LABELS,
};

/** A work event as the rules read it. */
export type RuleEvent = {
  id: string;
  kind: string;
  at: string;
  actor: string;
  issueKey: string | null;
  ref: string | null;
  summary: string;
  data: unknown;
};

/** An open wait on one of the item's tickets, with what the chase and timing need. */
export type RuleWait = {
  id: string;
  issueKey: string;
  label: string;
  status: "open" | "waiting" | "blocked" | "resolved";
  externalRef: string | null;
  ownerPersonId: string | null;
  ownerTeamId: string | null;
  /** The owner's name: a contact, a team, or "No owner". */
  ownerName: string;
  /** The person owner's Jira user, to match a blocker's assignee. */
  ownerJira: string | null;
  requestedAt: string | null;
  expectedAt: string | null;
  nextFollowupAt: string | null;
  lastFollowupAt: string | null;
  ownerAway: OwnerAway | null;
  /** What the playbooks remember (Phase 26): the status a playbook moved its ticket from. */
  data?: WaitData | null;
};

/** Who asked for a ticket (FR-10.4): a small ask's requester, by ticket key. */
export type RuleRequester = { personId: string; name: string; askedOn: string | null };

/** What the last run saw for an item: the dates a move is measured against, and the last event read. */
export type RuleMemory = {
  nextExpectedOn: string | null;
  /** Expected date of each open wait, by id. */
  waits: Record<string, string | null>;
  lastEventId: string | null;
};

export type RuleContact = { id: string; name: string; channel: "teams" | "email" };

export type RuleInput = {
  item: { id: string; name: string };
  facts: ItemFacts;
  state: WorkState | null;
  /** What the last run saw for this item; null the first time, when nothing counts as moved. */
  previous: RuleMemory | null;
  /** Events attached to the item since the last run. */
  newEvents: readonly RuleEvent[];
  /** The item's recent events, for "nothing sent since" checks. */
  history: readonly RuleEvent[];
  waits: readonly RuleWait[];
  /** Every "is blocked by" key of each ticket, done or not. */
  blockedBy: Readonly<Record<string, readonly string[]>>;
  /** Status names of each project, from the synced metadata. */
  statuses: Readonly<Record<string, readonly string[]>>;
  contacts: ReadonlyMap<string, RuleContact>;
  /** The user's Jira user and the names a comment would call them by. */
  me: { username: string | null; names: readonly string[] };
  /** Pending proposals anywhere: a step one of them already covers is left out. */
  pending: readonly ProposalPayload[];
  today: string;
  settings: Pick<AppSettings, "secretary" | "dependencies">;
  /** Rules dismissed twice on this item since the user last asked again (`quietRules`). */
  quiet: ReadonlySet<RuleName>;
  /** Requesters on record (Phase 26, `ticket_done`), by ticket key. */
  requesters?: Readonly<Record<string, RuleRequester>>;
  /**
   * Waits a "wait resolved" bundle resolves or resolved (Phase 26): it already
   * comments and moves the ticket back, so `blocker_closed` does not again.
   */
  handledWaits?: readonly { issueKey: string; label: string; externalRef: string | null }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** FNV-1a over the canonical JSON; enough to tell facts apart. */
export function fingerprint(value: unknown): string {
  let h = 0x811c9dc5;
  const s = JSON.stringify(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** `<rule>:<work_item_id>:<fingerprint of the facts>` (D61). */
export const situationKey = (rule: SituationKind, itemId: string, facts: unknown) =>
  `${rule}:${itemId}:${fingerprint(facts)}`;

/** "24 Oct" for a YYYY-MM-DD date. */
export const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** Statuses a waiting ticket sits in (D61): Blocked, On hold, Waiting. */
export const BLOCKED_STATUS = /\b(blocked|on[\s-]?hold|waiting)\b/i;
const DONE_LIKE = /\b(done|closed|resolved|cancel+ed|won'?t)\b/i;

/** The project's in-progress status by name, for resuming a ticket; null when none reads so. */
export function inProgressStatus(statuses: readonly string[]): string | null {
  const usable = statuses.filter((s) => !BLOCKED_STATUS.test(s) && !DONE_LIKE.test(s));
  return (
    usable.find((s) => /^in progress$/i.test(s)) ??
    usable.find((s) => /in progress/i.test(s)) ??
    usable.find((s) => /progress|doing|develop|working|active/i.test(s)) ??
    null
  );
}

const quoteOf = (text: string, max = 160) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const openPrimary = (f: ItemFacts) =>
  f.tickets.filter((t) => t.role === "primary" && !t.unknown && t.statusCategory !== "done");

const projectOf = (key: string) => key.split("-")[0] ?? key;

/** What makes two steps the same, so a pending proposal that covers a step leaves it out. */
function sameStep(a: ProposalPayload, b: ProposalPayload): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "update_dependency":
      return (
        b.kind === a.kind &&
        b.dependencyId === a.dependencyId &&
        b.action === a.action &&
        (a.action === "resolve" ||
          ((b.expectedAt ?? null) === (a.expectedAt ?? null) &&
            (b.nextFollowupAt ?? null) === (a.nextFollowupAt ?? null)))
      );
    case "update_issue":
      return (
        b.kind === a.kind &&
        b.target === a.target &&
        Object.keys(a.changes).every((k) => k in b.changes)
      );
    case "transition_issue":
      return b.kind === a.kind && b.target === a.target;
    case "add_comment":
      return b.kind === a.kind && b.target === a.target && b.bodyMd.trim() === a.bodyMd.trim();
    case "draft_message":
      return (
        b.kind === a.kind &&
        b.intent === a.intent &&
        b.recipientPersonId === a.recipientPersonId &&
        b.recipientTeamId === a.recipientTeamId
      );
    default:
      return false;
  }
}

/** Steps that parse as canonical payloads and are not already pending elsewhere. */
function keepSteps(steps: readonly StepDraft[], pending: readonly ProposalPayload[]): StepDraft[] {
  return steps.flatMap((s) => {
    const parsed = ProposalPayloadSchema.safeParse(s.payload);
    if (!parsed.success) return [];
    if (pending.some((p) => sameStep(parsed.data, p))) return [];
    return [{ ...s, payload: parsed.data }];
  });
}

/** A step; fields with defaults may be left out, `keepSteps` parses it into the canonical payload. */
const step = (payload: StoredProposalPayload, label: string, required = false): StepDraft => ({
  payload: payload as ProposalPayload,
  label,
  required,
  choice: false,
});

const channelOf = (input: RuleInput, personId: string | null) =>
  (personId ? input.contacts.get(personId)?.channel : undefined) ?? "teams";

// ---------------------------------------------------------------------------
// expected_date_moved
// ---------------------------------------------------------------------------

/**
 * A wait's expected date changed, or the state's next expected date moved,
 * since the last run. Steps: the wait still on the old date moves (the step the
 * others hang on); each open primary ticket due before the new date gets it as
 * its due date; each contact the state lists an open promise to gets a draft
 * with the new date.
 */
export function expectedDateMoved(input: RuleInput): Situation[] {
  const prev = input.previous;
  if (!prev) return [];
  const open = input.waits.filter((w) => w.status !== "resolved");
  const out: Situation[] = [];

  // A first date (nothing was expected before) is no move: nobody was told an
  // earlier date, so the only step is the one wait without a date taking it.
  const on = input.state?.nextExpected?.on ?? null;
  if (on && !prev.nextExpectedOn) {
    const undated = open.filter((w) => !w.expectedAt);
    const w = undated.length === 1 ? undated[0] : undefined;
    const steps = w
      ? keepSteps(
          [
            step(
              {
                kind: "update_dependency",
                dependencyId: w.id,
                action: "reschedule",
                summary: `Expected ${on}`,
                expectedAt: on,
                nextFollowupAt: nextFollowupAfter({ nextFollowupAt: null, expectedAt: on }) ?? null,
                channel: "other",
                issueKey: w.issueKey,
                label: w.label,
              },
              `Expect "${w.label}" from ${w.ownerName} on ${dayLabel(on)}`,
            ),
          ],
          input.pending,
        )
      : [];
    if (w && steps.length)
      out.push({
        rule: "expected_date_moved",
        key: situationKey("expected_date_moved", input.item.id, { from: null, to: on }),
        title: `Expected ${dayLabel(on)}`,
        why: `"${input.state?.nextExpected?.what ?? "The next step"}" is now expected ${dayLabel(on)}; the wait on ${w.ownerName} for "${w.label}" has no date yet.`,
        keys: [w.issueKey],
        waits: [w.id],
        comments: [],
        facts: { from: null, to: on, via: ["state"] },
        steps,
      });
  }

  // Moves: a wait's date or the state's next date changed from one date to another.
  const moves = new Map<string, { from: string; to: string; via: string[] }>();
  const add = (from: string, to: string, via: string) => {
    const k = `${from}|${to}`;
    const m = moves.get(k) ?? { from, to, via: [] };
    m.via.push(via);
    moves.set(k, m);
  };
  for (const w of open) {
    if (!Object.hasOwn(prev.waits, w.id)) continue;
    const was = prev.waits[w.id] ?? null;
    if (was && w.expectedAt && was !== w.expectedAt) add(was, w.expectedAt, `wait:${w.id}`);
  }
  if (on && prev.nextExpectedOn && on !== prev.nextExpectedOn)
    add(prev.nextExpectedOn, on, "state");

  for (const { from, to, via } of moves.values()) {
    const waitSteps = open
      .filter((w) => w.expectedAt === from)
      .map((w) =>
        step(
          {
            kind: "update_dependency",
            dependencyId: w.id,
            action: "reschedule",
            summary: `New expected date ${to} (was ${from})`,
            expectedAt: to,
            nextFollowupAt: nextFollowupAfter({ nextFollowupAt: null, expectedAt: to }) ?? null,
            channel: "other",
            issueKey: w.issueKey,
            label: w.label,
          },
          `Move the wait on ${w.ownerName} for "${w.label}" to ${dayLabel(to)}`,
          true,
        ),
      );
    const dueSteps = openPrimary(input.facts)
      .filter((t) => !!t.dueDate && t.dueDate < to)
      .map((t) =>
        step(
          { kind: "update_issue", target: t.key, changes: { dueDate: to } },
          `Move ${t.key}'s due date from ${dayLabel(t.dueDate ?? to)} to ${dayLabel(to)}`,
        ),
      );
    const owed = new Map<string, string[]>();
    for (const c of input.state?.commitments ?? [])
      if (c.status === "open" && c.toPersonId && input.contacts.has(c.toPersonId))
        owed.set(c.toPersonId, [...(owed.get(c.toPersonId) ?? []), c.what]);
    const keys = openPrimary(input.facts).map((t) => t.key);
    const draftSteps = [...owed].map(([personId, whats]) => {
      const name = input.contacts.get(personId)?.name ?? "them";
      return step(
        {
          kind: "draft_message",
          channel: channelOf(input, personId),
          intent: "status_update",
          recipientPersonId: personId,
          recipientTeamId: null,
          issueKeys: keys,
          notes: `New date: ${dayLabel(to)} (was ${dayLabel(from)}). You promised ${name}: ${whats.join("; ")}.`,
          dependencyId: null,
          quote: null,
        },
        `Tell ${name} the new date (you promised: ${whats.join("; ")})`,
      );
    });
    const steps = keepSteps([...waitSteps, ...dueSteps, ...draftSteps], input.pending);
    if (steps.length === 0) continue;
    const wait = via.find((v) => v.startsWith("wait:"));
    const moved = wait ? open.find((w) => `wait:${w.id}` === wait) : undefined;
    const what = moved
      ? `${moved.ownerName} for "${moved.label}" on ${moved.issueKey}`
      : `"${input.state?.nextExpected?.what ?? "The next step"}"`;
    const waitIds = [
      ...new Set([
        ...(moved ? [moved.id] : []),
        ...steps.flatMap((s) =>
          s.payload.kind === "update_dependency" ? [s.payload.dependencyId] : [],
        ),
      ]),
    ];
    out.push({
      rule: "expected_date_moved",
      // From and to: the state moving and the wait following it is one situation,
      // and a date moving back to an earlier one is a new one.
      key: situationKey("expected_date_moved", input.item.id, { from, to }),
      title: `Now expected ${dayLabel(to)}, not ${dayLabel(from)}`,
      why: `${what} moved from ${dayLabel(from)} to ${dayLabel(to)}.`,
      keys: [
        ...new Set([
          ...open.filter((w) => waitIds.includes(w.id)).map((w) => w.issueKey),
          ...dueSteps.map((s) => (s.payload.kind === "update_issue" ? s.payload.target : "")),
        ]),
      ].filter(Boolean),
      waits: waitIds,
      comments: [],
      facts: { from, to, via },
      steps,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// blocker_closed
// ---------------------------------------------------------------------------

/** The status a ticket was in before it moved into its blocked-like status, from the item's events. */
function statusBefore(input: RuleInput, t: FactTicket): string | null {
  const moves = input.history
    .filter((e) => e.issueKey === t.key && (e.kind === "jira_change" || e.kind === "ticket_edited"))
    .map((e) => ({ e, d: eventData(e.data) }))
    .filter(({ d }) => d.field === "status" && d.to === t.status)
    .sort((a, b) => b.e.id.localeCompare(a.e.id));
  const from = moves[0]?.d.from;
  return from && !BLOCKED_STATUS.test(from) && !DONE_LIKE.test(from) ? from : null;
}

/** A status or resolution change into done: to a done status from one that was not, or resolved. */
function closes(d: ReturnType<typeof eventData>, status: string | null): boolean {
  if (d.field === "resolution") return !d.from && !!d.to;
  if (d.field !== "status") return false;
  const into = !!d.to && (DONE_LIKE.test(d.to) || d.to === status);
  return into && !(d.from && DONE_LIKE.test(d.from));
}

/** A change out of done: the blocker reopened. */
function reopens(d: ReturnType<typeof eventData>): boolean {
  if (d.field === "resolution") return !!d.from && !d.to;
  return (
    d.field === "status" && !!d.from && DONE_LIKE.test(d.from) && !(d.to && DONE_LIKE.test(d.to))
  );
}

const mentions = (text: string, key: string) =>
  new RegExp(`(^|[^A-Z0-9_])${key.replace(/[-]/g, "\\-")}($|[^0-9])`, "i").test(text);

/**
 * A related ticket turned done (a sync `jira_change` on it, from the cached row
 * or the blocker map). Steps on each ticket that waited on it: move it back to
 * an in-progress status when it sits in a blocked-like one (the step the others
 * hang on), a comment saying so, and resolving the wait that names the blocker
 * or is owned by its assignee.
 */
export function blockerClosed(input: RuleInput): Situation[] {
  const byKey = new Map(input.facts.tickets.map((t) => [t.key, t]));
  const done = new Map<string, RuleEvent>();
  for (const e of input.newEvents) {
    if (e.kind !== "jira_change" || !e.issueKey) continue;
    const t = byKey.get(e.issueKey);
    if (t?.statusCategory !== "done") continue;
    // Only the move into done counts: Resolved to Closed, or a later resolution, is no news.
    if (closes(eventData(e.data), t.status)) done.set(e.issueKey, e);
  }
  const out: Situation[] = [];
  for (const [blocker, event] of done) {
    const b = byKey.get(blocker);
    // A ticket whose wait on this blocker a "wait resolved" bundle took care of is done.
    const handled = (t: FactTicket) =>
      (input.handledWaits ?? []).some(
        (h) => h.issueKey === t.key && mentions(`${h.label} ${h.externalRef ?? ""}`, blocker),
      );
    const primaries = openPrimary(input.facts).filter((t) => t.key !== blocker && !handled(t));
    let waiting = primaries.filter((t) => input.blockedBy[t.key]?.includes(blocker));
    if (waiting.length === 0 && b?.role === "related")
      waiting = primaries.filter((t) => BLOCKED_STATUS.test(t.status ?? ""));
    if (waiting.length === 0) continue;
    const steps: StepDraft[] = [];
    for (const t of waiting) {
      if (t.status && BLOCKED_STATUS.test(t.status)) {
        // A playbook that moved it to Blocked remembers where from (Phase 26).
        const remembered = input.waits.find(
          (w) =>
            w.issueKey === t.key &&
            w.data?.blocked?.issueKey === t.key &&
            w.data.blocked.to.toLowerCase() === (t.status ?? "").toLowerCase(),
        )?.data?.blocked?.from;
        const to =
          remembered ??
          statusBefore(input, t) ??
          inProgressStatus(input.statuses[projectOf(t.key)] ?? []);
        if (to)
          steps.push(
            step(
              { kind: "transition_issue", target: t.key, toStatus: to },
              `Move ${t.key} from ${t.status} to ${to}`,
              true,
            ),
          );
      }
      const body = `${blocker} is done; picking this up again.`;
      steps.push(
        step(
          { kind: "add_comment", target: t.key, bodyMd: body },
          `Comment on ${t.key}: "${body}"`,
        ),
      );
    }
    const user = b?.assigneeUser?.toLowerCase() ?? null;
    const display = b?.assignee?.toLowerCase() ?? null;
    for (const w of input.waits) {
      if (w.status === "resolved") continue;
      const named = mentions(`${w.label} ${w.externalRef ?? ""}`, blocker);
      // The owner's Jira user against the assignee's; the names only when one is missing.
      const owns =
        w.ownerJira && user
          ? w.ownerJira.toLowerCase() === user
          : !!display && w.ownerName.toLowerCase() === display;
      if (!named && !owns) continue;
      steps.push(
        step(
          {
            kind: "update_dependency",
            dependencyId: w.id,
            action: "resolve",
            summary: `${blocker} is done`,
            expectedAt: null,
            nextFollowupAt: null,
            channel: "jira",
            issueKey: w.issueKey,
            label: w.label,
          },
          `Resolve the wait on ${w.ownerName} for "${w.label}"`,
        ),
      );
    }
    const kept = keepSteps(steps, input.pending);
    if (kept.length === 0) continue;
    // Once per blocker until it reopens: the last reopening seen is part of the key.
    const reopened =
      input.history
        .filter((e) => e.issueKey === blocker && e.kind === "jira_change")
        .filter((e) => reopens(eventData(e.data)))
        .map((e) => e.id)
        .sort()
        .at(-1) ?? null;
    out.push({
      rule: "blocker_closed",
      key: situationKey("blocker_closed", input.item.id, { blocker, reopened }),
      title: `${blocker} is done: pick up ${waiting.map((t) => t.key).join(", ")}`,
      why: `${blocker}${b?.summary ? ` "${b.summary}"` : ""} moved to ${b?.status ?? "done"}; ${waiting
        .map((t) => `${t.key} is ${t.status ?? "open"}`)
        .join(", ")}.`,
      keys: waiting.map((t) => t.key),
      waits: kept.flatMap((s) =>
        s.payload.kind === "update_dependency" ? [s.payload.dependencyId] : [],
      ),
      comments: [],
      facts: { blocker, reopened, event: event.id, waiting: waiting.map((t) => t.key) },
      steps: kept,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// commitment_due
// ---------------------------------------------------------------------------

/**
 * An open promise due today or before, with nothing sent to that person since
 * it was made. One step: a draft to them with what was promised. A promise to
 * someone who is no contact is a reminder with no step (a draft needs one).
 */
export function commitmentDue(input: RuleInput): Situation[] {
  const out: Situation[] = [];
  const keys = openPrimary(input.facts).map((t) => t.key);
  for (const c of input.state?.commitments ?? []) {
    if (c.status !== "open" || !c.dueOn || c.dueOn > input.today) continue;
    const since = input.history.find((e) => e.id === c.saidIn)?.at ?? null;
    const sent =
      !!c.toPersonId &&
      input.history.some(
        (e) =>
          e.kind === "draft_sent" &&
          (eventData(e.data).contactIds ?? []).includes(c.toPersonId ?? "") &&
          (!since || e.at >= since),
      );
    if (sent) continue;
    const contact = c.toPersonId ? input.contacts.get(c.toPersonId) : undefined;
    const name = contact?.name ?? c.toName ?? "them";
    const late = c.dueOn < input.today;
    const steps = contact
      ? keepSteps(
          [
            step(
              {
                kind: "draft_message",
                channel: contact.channel,
                intent: "status_update",
                recipientPersonId: contact.id,
                recipientTeamId: null,
                issueKeys: keys,
                notes: `You promised ${name}: ${c.what}, by ${dayLabel(c.dueOn)}. ${
                  late
                    ? "It is late: say where it stands and when it will be done."
                    : "It is due today."
                }`,
                dependencyId: null,
                quote: null,
              },
              `Write to ${name} about "${c.what}"`,
            ),
          ],
          input.pending,
        )
      : [];
    if (contact && steps.length === 0) continue;
    out.push({
      rule: "commitment_due",
      key: situationKey("commitment_due", input.item.id, {
        saidIn: c.saidIn,
        what: c.what,
        dueOn: c.dueOn,
      }),
      title: `${late ? "Late" : "Due today"}: ${c.what} (to ${name})`,
      why: `You promised ${name} "${c.what}" by ${dayLabel(c.dueOn)}${
        late ? "" : ", which is today"
      }, and nothing was sent to them since.`,
      keys: [],
      waits: [],
      comments: [],
      facts: { saidIn: c.saidIn, what: c.what, dueOn: c.dueOn, to: c.toPersonId ?? c.toName },
      steps,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// teammate_touched
// ---------------------------------------------------------------------------

/** Whether a comment asks the user something: a question mark, or their name or username. */
export function asksMe(text: string, me: RuleInput["me"]): boolean {
  if (text.includes("?")) return true;
  const names = [me.username, ...me.names].filter((n): n is string => !!n && n.trim().length >= 3);
  return names.some((n) =>
    new RegExp(
      `(^|[^\\p{L}\\p{N}])${n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
      "iu",
    ).test(text),
  );
}

const someoneElse = (actor: string) => actor.startsWith("contact:") || actor.startsWith("jira:");

/**
 * Someone else commented on (or, with a known author, changed) one of the
 * item's primary tickets since the last run. The card is the "read it"
 * reminder; when a comment asks the user something and its author is a
 * contact, one step drafts the answer. Jira does not say who changed a field
 * at sync (D61), so a field change counts only once its author is known.
 */
export function teammateTouched(input: RuleInput): Situation[] {
  const primary = new Set(openPrimary(input.facts).map((t) => t.key));
  const groups = new Map<string, RuleEvent[]>();
  for (const e of input.newEvents) {
    if (e.kind !== "jira_comment" && e.kind !== "jira_change") continue;
    if (!e.issueKey || !primary.has(e.issueKey) || !someoneElse(e.actor)) continue;
    const k = `${e.issueKey}|${e.actor}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out: Situation[] = [];
  for (const events of groups.values()) {
    const sorted = [...events].sort((a, b) => a.id.localeCompare(b.id));
    const last = sorted.at(-1);
    if (!last?.issueKey) continue;
    const key = last.issueKey;
    const contactId = last.actor.startsWith("contact:") ? last.actor.slice(8) : null;
    const contact = contactId ? input.contacts.get(contactId) : undefined;
    const name =
      contact?.name ?? (last.actor.startsWith("jira:") ? last.actor.slice(5) : "Someone");
    const comments = sorted.filter((e) => e.kind === "jira_comment");
    const asking = comments.filter((e) => asksMe(eventData(e.data).text ?? "", input.me)).at(-1);
    const quote = asking ? quoteOf(eventData(asking.data).text ?? "") : null;
    // Their words are not the user's request: the notes only name the comment, and
    // the words travel as `quote`, which the draft prompt shows as untrusted.
    const steps =
      asking && contact
        ? keepSteps(
            [
              step(
                {
                  kind: "draft_message",
                  channel: contact.channel,
                  intent: "status_update",
                  recipientPersonId: contact.id,
                  recipientTeamId: null,
                  issueKeys: [key],
                  notes: `Answer ${name}'s question in their comment on ${key} (${dayLabel(localDateOf(asking.at))}).`,
                  dependencyId: null,
                  quote: (eventData(asking.data).text ?? "").trim().slice(0, 2000) || null,
                },
                `Reply to ${name}`,
              ),
            ],
            input.pending,
          )
        : [];
    const latestText = comments.at(-1) ? quoteOf(eventData(comments.at(-1)?.data).text ?? "") : "";
    out.push({
      rule: "teammate_touched",
      key: situationKey(
        "teammate_touched",
        input.item.id,
        sorted.map((e) => e.ref ?? e.id),
      ),
      title: comments.length
        ? `${name} ${asking ? "asks you something" : "commented"} on ${key}`
        : `${name} changed ${key}`,
      why: comments.length ? `"${quote ?? latestText}"` : sorted.map((e) => e.summary).join("; "),
      keys: [key],
      waits: [],
      comments: comments.map((e) => e.ref ?? e.id),
      facts: { issueKey: key, actor: last.actor, events: sorted.map((e) => e.id), asks: !!asking },
      steps,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// wait_unanswered
// ---------------------------------------------------------------------------

/**
 * An open wait whose follow-up is due (today or past, not while the owner is
 * away) with no chase and no message to the owner since the last follow-up.
 * Steps: a chase draft (the step the other hangs on), and the next follow-up
 * date.
 */
export function waitUnanswered(input: RuleInput): Situation[] {
  const out: Situation[] = [];
  for (const w of input.waits) {
    if (w.status === "resolved") continue;
    const t = timing(w, input.today);
    if (!t.followupDue || t.asleep) continue;
    if (!w.ownerPersonId && !w.ownerTeamId) continue;
    const since = w.lastFollowupAt ?? w.requestedAt ?? "";
    const chased = input.history.some((e) => {
      if (e.at <= since) return false;
      const d = eventData(e.data);
      if (e.kind === "wait_chased") return d.dependencyId === w.id;
      if (e.kind === "draft_sent")
        return (
          d.dependencyId === w.id ||
          (!!w.ownerPersonId && (d.contactIds ?? []).includes(w.ownerPersonId))
        );
      return false;
    });
    if (chased) continue;
    const channel = channelOf(input, w.ownerPersonId);
    const next =
      nextFollowupAfter({
        nextFollowupAt: null,
        expectedAt: w.expectedAt && w.expectedAt > input.today ? w.expectedAt : null,
      }) ?? addBusinessDays(input.today, input.settings.dependencies.followupDays);
    const steps = keepSteps(
      [
        step(
          {
            kind: "draft_message",
            channel,
            intent: "chase",
            recipientPersonId: w.ownerPersonId,
            recipientTeamId: w.ownerPersonId ? null : w.ownerTeamId,
            issueKeys: [w.issueKey],
            notes: chaseNotes(w),
            // Marking the draft sent logs the follow-up on the wait (D61).
            dependencyId: w.id,
            quote: null,
          },
          `Draft a chase to ${w.ownerName}`,
          true,
        ),
        step(
          {
            kind: "update_dependency",
            dependencyId: w.id,
            action: "reschedule",
            summary: `Follow-up planned for ${next}`,
            logged: false,
            expectedAt: null,
            nextFollowupAt: next,
            channel,
            issueKey: w.issueKey,
            label: w.label,
          },
          `Next follow-up on ${dayLabel(next)}`,
        ),
      ],
      input.pending,
    );
    if (steps.length === 0) continue;
    // The chase_due playbook (Phase 26): say on the ticket that it still waits, when
    // the standing instruction says so and nothing was said there within the interval.
    if (input.settings.secretary.instructions.commentWaits) {
      const said = lastCommentOn(input, w.issueKey);
      const stale =
        !said ||
        addBusinessDays(localDateOf(said), input.settings.dependencies.followupDays) <= input.today;
      const body = stillWaitingComment(w);
      if (stale)
        steps.push(
          ...keepSteps(
            [
              step(
                { kind: "add_comment", target: w.issueKey, bodyMd: body },
                `Comment on ${w.issueKey}: "${body}"`,
              ),
            ],
            input.pending,
          ),
        );
    }
    const due = t.followupOn ?? w.nextFollowupAt ?? input.today;
    out.push({
      rule: "wait_unanswered",
      key: situationKey("wait_unanswered", input.item.id, { wait: w.id, due }),
      title: `Chase ${w.ownerName}: ${w.label}`,
      why: `${t.reason ?? `The follow-up was due ${dayLabel(due)}`}; nothing heard${
        since ? ` since ${dayLabel(localDateOf(since))}` : ""
      }${w.expectedAt ? `, expected ${dayLabel(w.expectedAt)}` : ""}.`,
      keys: [w.issueKey],
      waits: [w.id],
      comments: [],
      facts: { wait: w.id, due, since: since || null },
      steps,
    });
  }
  return out;
}

/** "Still waiting on Platform for the cert, expected 24 Oct." */
export const stillWaitingComment = (w: Pick<RuleWait, "ownerName" | "label" | "expectedAt">) =>
  `Still waiting on ${w.ownerName} for ${w.label}${w.expectedAt ? `, expected ${dayLabel(w.expectedAt)}` : ""}.`;

/** When the user last commented on a ticket from the app (an approved comment or their own edit). */
function lastCommentOn(input: RuleInput, key: string): string | null {
  return (
    input.history
      .filter((e) => {
        if (e.issueKey !== key) return false;
        const d = eventData(e.data) as { proposalKind?: unknown; field?: unknown };
        return (
          (e.kind === "proposal_executed" && d.proposalKind === "add_comment") ||
          (e.kind === "ticket_edited" && d.field === "comment")
        );
      })
      .map((e) => e.at)
      .sort()
      .at(-1) ?? null
  );
}

// ---------------------------------------------------------------------------
// ticket_done (Phase 26)
// ---------------------------------------------------------------------------

/** "Done; Dana Lee asked for this on 2 Oct." */
export const doneComment = (r: RuleRequester) =>
  `Done; ${r.name} asked for this${r.askedOn ? ` on ${dayLabel(r.askedOn)}` : ""}.`;

/**
 * One of the item's primary tickets turned done by the user: from the ticket
 * view, by an approved move (the user saying so in chat or a paste is
 * classify's transition, approved), or in Jira when the change names them
 * (a sync change by an unknown author does not count). Steps: resolve each wait still open on
 * it; a closing note on it naming who asked and when, when a requester is on
 * record and `commentWaits` is on; a note to the requester when it is a small
 * ask (a requester on record, FR-10.4). Tickets it blocked wake at the next
 * blocker check (D45), so that needs no step.
 */
export function ticketDone(input: RuleInput): Situation[] {
  const byKey = new Map(input.facts.tickets.map((t) => [t.key, t]));
  const done = new Map<string, RuleEvent>();
  for (const e of input.newEvents) {
    if (!e.issueKey) continue;
    const t = byKey.get(e.issueKey);
    if (!t || t.unknown || t.role !== "primary" || t.statusCategory !== "done") continue;
    // Done by the user: their edit or approval ("me"), or a change Jira says they made.
    const user = input.me.username?.toLowerCase();
    if (e.actor !== "me" && !(user && e.actor.toLowerCase() === `jira:${user}`)) continue;
    const d = eventData(e.data) as ReturnType<typeof eventData> & { proposalKind?: unknown };
    const moved =
      ((e.kind === "jira_change" || e.kind === "ticket_edited") && closes(d, t.status)) ||
      (e.kind === "proposal_executed" && d.proposalKind === "transition_issue");
    if (moved && !done.has(e.issueKey)) done.set(e.issueKey, e);
  }
  const out: Situation[] = [];
  for (const [key, event] of done) {
    const t = byKey.get(key);
    const steps: StepDraft[] = [];
    const open = input.waits.filter((w) => w.issueKey === key && w.status !== "resolved");
    for (const w of open)
      steps.push(
        step(
          {
            kind: "update_dependency",
            dependencyId: w.id,
            action: "resolve",
            summary: `${key} is done`,
            expectedAt: null,
            nextFollowupAt: null,
            channel: "other",
            issueKey: w.issueKey,
            label: w.label,
          },
          `Resolve the wait on ${w.ownerName} for "${w.label}"`,
        ),
      );
    const requester = input.requesters?.[key];
    if (requester && input.settings.secretary.instructions.commentWaits) {
      const body = doneComment(requester);
      steps.push(
        step({ kind: "add_comment", target: key, bodyMd: body }, `Comment on ${key}: "${body}"`),
      );
    }
    const contact = requester ? input.contacts.get(requester.personId) : undefined;
    if (requester && contact)
      steps.push(
        step(
          {
            kind: "draft_message",
            channel: contact.channel,
            intent: "status_update",
            recipientPersonId: contact.id,
            recipientTeamId: null,
            issueKeys: [key],
            notes: `Tell ${contact.name} that ${key}${t?.summary ? ` "${t.summary}"` : ""} is done.`,
            dependencyId: null,
            quote: null,
          },
          `Tell ${contact.name} it is done`,
        ),
      );
    const kept = keepSteps(steps, input.pending);
    if (kept.length === 0) continue;
    out.push({
      rule: "ticket_done",
      key: situationKey("ticket_done", input.item.id, { key, event: event.id }),
      title: `${key} is done: tidy up`,
      why: `${key}${t?.summary ? ` "${t.summary}"` : ""} moved to ${t?.status ?? "done"}${
        open.length ? `; ${open.length} wait${open.length === 1 ? "" : "s"} still open on it` : ""
      }${requester ? `; ${requester.name} asked for it` : ""}.`,
      keys: [key],
      waits: kept.flatMap((s) =>
        s.payload.kind === "update_dependency" ? [s.payload.dependencyId] : [],
      ),
      comments: [],
      facts: { key, event: event.id },
      steps: kept,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// All rules
// ---------------------------------------------------------------------------

const RULES: Record<RuleName, (input: RuleInput) => Situation[]> = {
  expected_date_moved: expectedDateMoved,
  blocker_closed: blockerClosed,
  commitment_due: commitmentDue,
  teammate_touched: teammateTouched,
  wait_unanswered: waitUnanswered,
  ticket_done: ticketDone,
};

/** Every situation of one item, in the rules' priority order; switched-off and quiet rules give none. */
export function runRules(input: RuleInput): Situation[] {
  const out: Situation[] = [];
  for (const name of RULE_NAMES) {
    if (!input.settings.secretary.rules[name] || input.quiet.has(name)) continue;
    // A step an earlier rule already offers is not offered twice (one wait update, one draft).
    const pending = [...input.pending, ...out.flatMap((s) => s.steps.map((x) => x.payload))];
    out.push(...RULES[name]({ ...input, pending }));
  }
  return out;
}

/**
 * Rules gone quiet on an item (D61): dismissed twice there since the user last
 * asked again. Derived from the item's `outcome_dismissed` and `rule_resumed`
 * events, so no counter is stored.
 */
export function quietRules(
  events: readonly { id: string; kind: string; data: unknown }[],
): Set<RuleName> {
  const counts = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.id.localeCompare(b.id))) {
    const data = eventData(e.data) as { rule?: unknown; ran?: unknown };
    const rule = data.rule;
    if (typeof rule !== "string") continue;
    // A card dismissed after one of its steps ran was taken up, not turned down.
    if (e.kind === "outcome_dismissed" && data.ran === true) continue;
    if (e.kind === "rule_resumed") counts.set(rule, 0);
    if (e.kind === "outcome_dismissed") counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return new Set(RULE_NAMES.filter((r) => (counts.get(r) ?? 0) >= 2));
}

/**
 * The status note of a work item (FR-19.3): a few lines from the state and the
 * facts, or the user's own words while they hold. A note the user wrote is kept
 * word for word until a fact it names changes: the tickets, waits and dates it
 * mentions are fingerprinted when it is written and compared after each pass.
 */
import type { ItemFacts } from "./facts";
import type { WorkState } from "./schema";

const KEY_SCAN = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

const dayMonth = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** The note code writes: the state's words where it has them, else what the facts say. */
export function derivedNote(
  state: WorkState | null,
  facts: ItemFacts,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const lines: string[] = [];
  if (state?.goal) lines.push(state.goal.endsWith(".") ? state.goal : `${state.goal}.`);
  if (state?.currentStep) lines.push(`Now: ${state.currentStep}`);
  else {
    const primary = facts.tickets.filter((t) => t.role === "primary");
    const open = primary.filter((t) => t.statusCategory !== "done");
    if (open.length)
      lines.push(
        `Now: ${open
          .slice(0, 3)
          .map(
            (t) =>
              `${t.key} ${t.status ?? "open"}${t.blockedBy.length ? `, blocked by ${t.blockedBy.join(", ")}` : ""}`,
          )
          .join("; ")}`,
      );
    else if (primary.length) lines.push("All tickets are done.");
  }
  if (state?.nextExpected)
    lines.push(
      `Next: ${state.nextExpected.what}${state.nextExpected.on ? ` (${dayMonth(state.nextExpected.on)})` : ""}`,
    );
  else {
    const wait = [...facts.waits]
      .filter((w) => w.status !== "resolved")
      .sort((a, b) => (a.expectedAt ?? "9999").localeCompare(b.expectedAt ?? "9999"))[0];
    if (wait)
      lines.push(
        `Waiting on ${wait.owner} for ${wait.label}${wait.expectedAt ? `, expected ${dayMonth(wait.expectedAt)}` : ""}`,
      );
  }
  for (const c of state?.commitments.filter((x) => x.status === "open").slice(0, 3) ?? []) {
    const to = (c.toPersonId && names.get(c.toPersonId)) || c.toName || "someone";
    lines.push(`Promised ${to}: ${c.what}${c.dueOn ? ` by ${dayMonth(c.dueOn)}` : ""}`);
  }
  return lines.join("\n");
}

/** The facts a note names, as they are now; the note is released when this changes. */
export function noteFacts(note: string, facts: ItemFacts): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = note.toLowerCase();
  const named = new Set(note.match(KEY_SCAN) ?? []);
  for (const t of facts.tickets)
    if (named.has(t.key))
      out[`ticket:${t.key}`] = [t.status, t.assignee, t.dueDate, t.sprint].join("|");
  for (const w of facts.waits) {
    const owner = w.owner.toLowerCase();
    const first = owner.split(/\s+/)[0] ?? owner;
    const label = w.label.toLowerCase();
    if (
      named.has(w.issueKey) ||
      lower.includes(label) ||
      (first.length >= 3 &&
        new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower))
    )
      out[`wait:${w.id}`] = [w.status, w.expectedAt, w.nextFollowupAt].join("|");
  }
  return out;
}

/** Whether a fact the user's note names has changed since they wrote it. */
export function noteStillHolds(stored: unknown, note: string, facts: ItemFacts): boolean {
  const now = noteFacts(note, facts);
  const was = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(now), ...Object.keys(was)]);
  for (const k of keys) if (was[k] !== now[k]) return false;
  return true;
}

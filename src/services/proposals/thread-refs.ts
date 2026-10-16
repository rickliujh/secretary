/**
 * The new contacts and teams a thread proposes (D60), by their `$person:n` /
 * `$team:n` ref, so cards name them and the edit dialog offers them where a
 * contact or team goes before they exist.
 */
import { createdIds, effectivePayload, PERSON_REF_RE, TEAM_REF_RE } from "./schema";

export type ThreadRef = { ref: string; name: string };
export type ThreadRefs = {
  /** Creates that may still run (pending, approved, failed): what selects offer. */
  people: ThreadRef[];
  teams: ThreadRef[];
  /** Every create's name by its ref, whatever became of it, for display. */
  names: ReadonlyMap<string, string>;
  /** What executed creates made (or found existing), by ref. */
  made: ReadonlyMap<string, string>;
};

/** States whose create may still run. Executed ones are real rows by now. */
const OPEN = new Set(["pending", "approved", "failed"]);

export function threadRefs(
  rows: readonly { status: string; payload: unknown; editedPayload: unknown; result?: unknown }[],
): ThreadRefs {
  const people = new Map<string, string>();
  const teams = new Map<string, string>();
  const names = new Map<string, string>();
  for (const r of rows) {
    if (r.status === "superseded") continue;
    const p = effectivePayload(r);
    if (p.kind !== "create_person" && p.kind !== "create_team") continue;
    const name = p.kind === "create_person" ? p.displayName : p.name;
    names.set(p.ref, name);
    if (OPEN.has(r.status)) (p.kind === "create_person" ? people : teams).set(p.ref, name);
  }
  const list = (m: Map<string, string>) => [...m].map(([ref, name]) => ({ ref, name }));
  return {
    people: list(people),
    teams: list(teams),
    names,
    made: createdIds(rows.map((r) => ({ ...r, result: r.result ?? null }))),
  };
}

const isRef = (id: string) => PERSON_REF_RE.test(id) || TEAM_REF_RE.test(id);

/** A ref's name in the thread, else "new contact 2". */
export function refName(ref: string, refs: ThreadRefs | undefined): string {
  return (
    refs?.names.get(ref) ??
    `new ${PERSON_REF_RE.test(ref) ? "contact" : "team"} ${ref.split(":")[1]}`
  );
}

/**
 * A contact or team by id or ref, for display: an id by its name; a ref by what
 * its create made once it ran, by its name marked "(new)" while it may still
 * run, else by its name; null for none.
 */
export function directoryName(
  id: string | null | undefined,
  known: (id: string) => string | null | undefined,
  refs: ThreadRefs | undefined,
): string | null {
  if (!id) return null;
  if (!isRef(id)) return known(id) ?? id;
  const made = refs?.made.get(id);
  if (made) return known(made) ?? refs?.names.get(id) ?? made;
  const open = [...(refs?.people ?? []), ...(refs?.teams ?? [])].some((r) => r.ref === id);
  return open ? `${refName(id, refs)} (new)` : refName(id, refs);
}

/** "Approve the new contact Sarah Lee first; this proposal needs them." (D60) */
export function waitingMessage(waiting: readonly string[], refs: ThreadRefs): string {
  const person = waiting.some((r) => PERSON_REF_RE.test(r));
  const named = waiting.map((r) => refName(r, refs)).join(" and ");
  return `Approve the new ${person ? "contact" : "team"} ${named} first; this proposal needs ${
    person || waiting.length > 1 ? "them" : "it"
  }.`;
}

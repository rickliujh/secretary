/**
 * The small-asks home (FR-10, D44): pure rules code applies to a small ask, so
 * the model never chooses its project, label, assignee or sprint.
 */

/** Issue types a small ask may take in its home project: no epics, no sub-tasks. */
export function smallAskTypes(issueTypes: readonly string[]): string[] {
  return issueTypes.filter((t) => !/epic/i.test(t) && !isSubtaskType(t));
}

export const isSubtaskType = (t: string) => /sub-?task/i.test(t);

/** Task when the project has it, else the first standard type, else null. */
export function defaultSmallAskType(issueTypes: readonly string[]): string | null {
  const types = smallAskTypes(issueTypes);
  return types.find((t) => t.toLowerCase() === "task") ?? types[0] ?? null;
}

/** Create-screen fields the app fills for a small ask (D44), besides custom Epic Link. */
const FILLED = new Set([
  "project",
  "issuetype",
  "summary",
  "reporter",
  "description",
  "assignee",
  "duedate",
  "labels",
  "priority",
  "parent",
]);

export type CreateField = {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
};

/** Required fields without a default that the app cannot fill, by name. */
export function unfillableFields(
  fields: readonly CreateField[],
  alsoFilled: readonly string[] = [],
): string[] {
  const filled = new Set([...FILLED, ...alsoFilled]);
  return fields
    .filter((f) => f.required && !f.hasDefaultValue && !filled.has(f.fieldId))
    .map((f) => f.name);
}

const SOURCE_WORDS: Record<string, string> = {
  teams: "Teams",
  email: "email",
  meeting: "a meeting",
  typed: "a note",
  other: "a message",
};

export type Provenance = {
  /** Display name of who asked; null when nobody is known. */
  requester: string | null;
  source: string;
  /** YYYY-MM-DD the ask arrived. */
  date: string;
  /** The words the ask came in. */
  quote: string;
};

/** Longest quote kept in a description. */
const QUOTE_CHARS = 1000;

const PROVENANCE_RE =
  /(?:^|\n\n)_Asked (?:by .+? )?via .+? on \d{4}-\d{2}-\d{2}:_(?:\n\n(?:>.*(?:\n|$))*)?\s*$/;

/** "Asked by Ana Bell via Teams on 2026-09-24" (FR-10.4). */
export function askedByLine(p: Omit<Provenance, "quote">): string {
  const via = SOURCE_WORDS[p.source] ?? "a message";
  return `Asked ${p.requester ? `by ${p.requester} ` : ""}via ${via} on ${p.date}`;
}

/** The model's description without the provenance block code appended. */
export function stripProvenance(descriptionMd: string | null): string | null {
  if (!descriptionMd) return descriptionMd;
  const stripped = descriptionMd.replace(PROVENANCE_RE, "").trimEnd();
  return stripped || null;
}

/**
 * Appends who asked, how and when, with the quoted words, to a description.
 * Idempotent: a block already there is replaced, so a revised proposal does
 * not collect two.
 */
export function withProvenance(descriptionMd: string | null, p: Provenance): string {
  const quote = p.quote
    .trim()
    .slice(0, QUOTE_CHARS)
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");
  const block = `_${askedByLine(p)}:_${quote && quote !== ">" ? `\n\n${quote}` : ""}`;
  const base = stripProvenance(descriptionMd);
  return base ? `${base}\n\n${block}` : block;
}

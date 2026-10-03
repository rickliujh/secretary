/**
 * The small-asks home (FR-10, D44): pure rules code applies to a small ask, so
 * the model never chooses its project, label, assignee or sprint.
 */

/**
 * Whether a type is a sub-task type. `subtaskTypes` are the names Jira flags as
 * sub-tasks (project metadata stored at sync); only when they are unknown, as in
 * metadata stored before the flag was kept, does the name decide.
 */
export const isSubtaskType = (t: string, subtaskTypes?: readonly string[] | null) =>
  subtaskTypes ? subtaskTypes.includes(t) : /sub-?task/i.test(t);

/**
 * Sub-task type names across stored project metadata; null when any project's
 * metadata predates the flag, so callers fall back to names.
 */
export function knownSubtaskTypes(
  meta: Readonly<Record<string, { subtaskTypes?: readonly string[] }>>,
): string[] | null {
  const entries = Object.values(meta);
  if (entries.length === 0 || entries.some((m) => !m.subtaskTypes)) return null;
  return [...new Set(entries.flatMap((m) => m.subtaskTypes ?? []))].sort();
}

/** Issue types a small ask may take in its home project: no epics, no sub-tasks. */
export function smallAskTypes(
  issueTypes: readonly string[],
  subtaskTypes?: readonly string[] | null,
): string[] {
  return issueTypes.filter((t) => !/epic/i.test(t) && !isSubtaskType(t, subtaskTypes));
}

/** Task when the project has it, else the first standard type, else null. */
export function defaultSmallAskType(
  issueTypes: readonly string[],
  subtaskTypes?: readonly string[] | null,
): string | null {
  const types = smallAskTypes(issueTypes, subtaskTypes);
  return types.find((t) => t.toLowerCase() === "task") ?? types[0] ?? null;
}

/** Create-screen fields the app fills on every small ask (D44); Jira fills the reporter. */
const ALWAYS_FILLED = new Set([
  "project",
  "issuetype",
  "summary",
  "reporter",
  "description",
  "assignee",
  "labels",
]);
/** Fields filled only when the model gives a value (or, for parent, for a sub-task). */
const FILLED_WHEN_GIVEN = new Set(["duedate", "priority", "parent"]);
/** Fields every small ask sets; a create screen without one drops the value. */
const SET_ON_EVERY_ASK = [
  ["labels", "Labels"],
  ["assignee", "Assignee"],
  ["description", "Description"],
] as const;

export type CreateField = {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
};

export type CreateFieldCheck = {
  /** Required without a default, and the app never fills them: every create fails. */
  unfillable: string[];
  /** Required without a default, filled only when the model gives a value: an ask without one fails. */
  whenGiven: string[];
  /** Fields every small ask sets that the create screen does not have, so they are dropped. */
  notOnScreen: string[];
};

/**
 * What a create screen means for small asks (FR-10.1), by field name. `epicLink`
 * is the custom Epic Link field id, filled only when an epic is picked.
 */
export function checkCreateFields(
  fields: readonly CreateField[],
  epicLink?: string | null,
): CreateFieldCheck {
  const required = fields.filter((f) => f.required && !f.hasDefaultValue);
  const whenGiven = (f: CreateField) =>
    FILLED_WHEN_GIVEN.has(f.fieldId) || (!!epicLink && f.fieldId === epicLink);
  const ids = new Set(fields.map((f) => f.fieldId));
  return {
    unfillable: required
      .filter((f) => !ALWAYS_FILLED.has(f.fieldId) && !whenGiven(f))
      .map((f) => f.name),
    whenGiven: required.filter(whenGiven).map((f) => f.name),
    notOnScreen: SET_ON_EVERY_ASK.filter(([id]) => !ids.has(id)).map(([, name]) => name),
  };
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

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
/** The block code appends: the italic line, then the quote as `> ` lines, at the very end. */
const BLOCK_RE = new RegExp(
  String.raw`(?:^|\n\n)(_Asked (?:by .+? )?via .+? on (${DATE}):_)((?:\n\n(?:>.*(?:\n|$))*)?)\s*$`,
);
/** An "Asked by" line anywhere, such as one a model copied or made up. */
const ASKED_LINE_RE = new RegExp(
  String.raw`^[ \t>]*[_*]*Asked (?:by .+? )?via .+? on ${DATE}[.:]?[_*]*[.:]?[ \t]*$`,
  "gim",
);

/** "Asked by Ana Bell via Teams on 2026-09-24" (FR-10.4). */
export function askedByLine(p: Omit<Provenance, "quote">): string {
  const via = SOURCE_WORDS[p.source] ?? "a message";
  return `Asked ${p.requester ? `by ${p.requester} ` : ""}via ${via} on ${p.date}`;
}

/** The provenance block of a description, split off; null when it has none. */
export function splitProvenance(
  descriptionMd: string,
): { base: string | null; line: string; date: string; quote: string } | null {
  const m = BLOCK_RE.exec(descriptionMd);
  if (!m) return null;
  return {
    base: descriptionMd.slice(0, m.index).trimEnd() || null,
    line: m[1] ?? "",
    date: m[2] ?? "",
    quote: (m[3] ?? "")
      .trim()
      .split("\n")
      .map((l) => l.replace(/^> ?/, ""))
      .join("\n")
      .trim(),
  };
}

/** The date in a description's provenance block, so a revision keeps it. */
export const provenanceDate = (descriptionMd: string | null) =>
  descriptionMd ? (splitProvenance(descriptionMd)?.date ?? null) : null;

/**
 * The model's description without the provenance block code appended, and
 * without any other "Asked by" line: only code says who asked.
 */
export function stripProvenance(descriptionMd: string | null): string | null {
  if (!descriptionMd) return descriptionMd;
  const block = splitProvenance(descriptionMd);
  const base = block ? (block.base ?? "") : descriptionMd;
  const stripped = base
    .replace(ASKED_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

/**
 * Text shown literally in Jira wiki markup: a `{noformat}` block renders no
 * images, mentions, links or macros. A `{noformat}` inside the text would end
 * the block early, so it is broken up.
 */
export function literalWiki(text: string): string {
  return `{noformat}\n${text.replace(/\{(\s*noformat)/gi, "{ $1")}\n{noformat}`;
}

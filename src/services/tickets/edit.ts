/**
 * Editing an existing ticket from the ticket view (FR-17, D58): the field texts
 * the Edit dialog shows and parses, and the writes one Save makes, in order.
 * Only what changed is written.
 */
import type { JiraAction } from "@/services/executor/actions";
import { MAX_STORY_POINTS, StoryPoints } from "@/services/proposals/schema";
import { BACKLOG } from "@/services/sprints/options";

/** Story points as the points field shows them; empty for none. */
export const pointsText = (n: number | null) => (n === null ? "" : String(n));

/**
 * The points field's text: null when empty, undefined when it is not a valid
 * number of points. A decimal comma counts as a point ("0,5").
 */
export function parsePointsInput(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return undefined;
  const r = StoryPoints.safeParse(Number(t.replace(",", ".")));
  return r.success ? r.data : undefined;
}

/** Labels as the labels field shows them, separated by spaces. */
export const labelsText = (labels: readonly string[]) => labels.join(" ");

/** The longest label Jira takes. */
export const MAX_LABEL_LENGTH = 255;

/**
 * The labels field's text: labels separated by spaces or commas (a Jira label
 * holds no spaces), in the order typed, each once.
 */
export function parseLabelsInput(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** Whether two label lists hold the same labels, in any order. */
export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((l) => y.has(l));
}

/** The cached ticket fields the dialog edits. */
export type EditableIssue = {
  key: string;
  summary: string;
  priority: string | null;
  dueDate: string | null;
  description: string | null;
  storyPoints: number | null;
  labels: string[];
  epicKey: string | null;
  /** The team's name and id (D59); a team synced before ids were kept has no id. */
  team?: string | null;
  teamId?: string | null;
};

/**
 * The dialog's values, as text. `epic` and `team` are empty for none (`team`
 * holds the team's id, or CURRENT_TEAM for a team without one); `sprint` is a
 * sprint option's value.
 */
export type TicketEditValues = {
  summary: string;
  priority: string;
  dueDate: string;
  descriptionWiki: string;
  points: string;
  labels: string;
  epic: string;
  sprint: string;
  team: string;
};

/** The team value of a ticket whose team has no id yet: shown, never written (D59). */
export const CURRENT_TEAM = "__current_team__";

/** The dialog's starting values; `sprint` is the selected sprint option (`sprintChoices`). */
export function editValues(issue: EditableIssue, sprint: string): TicketEditValues {
  return {
    summary: issue.summary,
    priority: issue.priority ?? "",
    dueDate: issue.dueDate ?? "",
    descriptionWiki: (issue.description ?? "").replace(/\r\n/g, "\n"),
    points: pointsText(issue.storyPoints),
    labels: labelsText(issue.labels),
    epic: issue.epicKey ?? "",
    sprint,
    team: issue.teamId ?? (issue.team ? CURRENT_TEAM : ""),
  };
}

/** One write of a Save and what the toast calls its parts ("story points", "labels"). */
export type EditStep = { parts: string[]; action: JiraAction };

const partsText = (steps: readonly EditStep[]) => listText(steps.flatMap((s) => s.parts));

const FIELD_NAMES = {
  summary: "summary",
  priority: "priority",
  dueDate: "due date",
  descriptionWiki: "description",
  storyPoints: "story points",
  labels: "labels",
  team: "team",
} as const;

/** "a", "a and b", "a, b and c". */
export const listText = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/**
 * The writes a Save makes, in order (D58): one `update_fields` with the changed
 * fields (summary, priority, due date, description, points and labels in one
 * PUT), then `set_epic`, then the sprint move. `initial` is what the dialog
 * opened with; `sprintNames` names the sprint options by value. Points or
 * labels text that does not parse is the form's to refuse; here it is left
 * unchanged.
 */
export function ticketEditSteps(
  issue: EditableIssue,
  initial: TicketEditValues,
  values: TicketEditValues,
  sprintNames: Readonly<Record<string, string>> = {},
): EditStep[] {
  const fields: Extract<JiraAction, { kind: "update_fields" }>["fields"] = {};
  const summary = values.summary.trim();
  if (summary && summary !== initial.summary.trim()) fields.summary = summary;
  if (values.priority && values.priority !== initial.priority) fields.priority = values.priority;
  if (values.dueDate !== initial.dueDate) fields.dueDate = values.dueDate || null;
  if (values.descriptionWiki !== initial.descriptionWiki)
    fields.descriptionWiki = values.descriptionWiki || null;
  const points = parsePointsInput(values.points);
  if (points !== undefined && points !== issue.storyPoints) fields.storyPoints = points;
  const labels = parseLabelsInput(values.labels);
  if (!sameLabels(labels, issue.labels)) fields.labels = labels;
  if (values.team !== initial.team && values.team !== CURRENT_TEAM)
    fields.team = values.team || null;

  const steps: EditStep[] = [];
  const changed = Object.keys(fields) as (keyof typeof FIELD_NAMES)[];
  if (changed.length)
    steps.push({
      parts: changed.map((k) => FIELD_NAMES[k]),
      action: { kind: "update_fields", issueKey: issue.key, fields },
    });
  if (values.epic !== initial.epic)
    steps.push({
      parts: [values.epic ? `epic ${values.epic}` : "removing the epic"],
      action: { kind: "set_epic", issueKey: issue.key, epicKey: values.epic || null },
    });
  if (values.sprint && values.sprint !== initial.sprint) {
    if (values.sprint === BACKLOG)
      steps.push({
        parts: ["the move to the backlog"],
        action: { kind: "move_to_backlog", issueKey: issue.key },
      });
    else {
      const sprintId = Number(values.sprint);
      const sprintName = sprintNames[values.sprint];
      if (Number.isInteger(sprintId) && sprintId > 0)
        steps.push({
          parts: [`the move to ${sprintName ?? `sprint ${sprintId}`}`],
          action: {
            kind: "move_to_sprint",
            issueKey: issue.key,
            sprintId,
            ...(sprintName ? { sprintName } : {}),
          },
        });
    }
  }
  return steps;
}

type EditKey = keyof TicketEditValues;

/**
 * Whether two texts of a field mean the same: the summary ignores the spaces
 * at its ends (the form trims it), points compare as numbers ("3" and "3,0")
 * and labels as sets; anything else as typed.
 */
export function sameValue(key: EditKey, a: string, b: string): boolean {
  if (key === "summary") return a.trim() === b.trim();
  if (key === "points") {
    const [x, y] = [parsePointsInput(a), parsePointsInput(b)];
    return x !== undefined && y !== undefined ? x === y : a.trim() === b.trim();
  }
  if (key === "labels") return sameLabels(parseLabelsInput(a), parseLabelsInput(b));
  return a === b;
}

/**
 * The values a Save writes from (D58): a field the user changed since
 * `baseline` (what the dialog opened with, moved on by each Save) takes what
 * they typed; any other field takes the ticket as cached now, so what an
 * earlier partial Save wrote is not written again and a field changed in Jira
 * meanwhile is not written back.
 */
export function changedValues(
  baseline: TicketEditValues,
  submitted: TicketEditValues,
  cachedNow: TicketEditValues,
): TicketEditValues {
  const out = { ...cachedNow };
  for (const key of Object.keys(cachedNow) as EditKey[])
    if (!sameValue(key, submitted[key], baseline[key])) out[key] = submitted[key];
  return out;
}

const FORM_KEYS: Record<keyof typeof FIELD_NAMES, EditKey> = {
  summary: "summary",
  priority: "priority",
  dueDate: "dueDate",
  descriptionWiki: "descriptionWiki",
  storyPoints: "points",
  labels: "labels",
  team: "team",
};

/** The dialog's fields a written step changed. */
function writtenKeys(action: JiraAction): EditKey[] {
  switch (action.kind) {
    case "update_fields":
      return (Object.keys(action.fields) as (keyof typeof FIELD_NAMES)[]).map((k) => FORM_KEYS[k]);
    case "set_epic":
      return ["epic"];
    case "move_to_sprint":
    case "move_to_backlog":
      return ["sprint"];
    default:
      return [];
  }
}

/**
 * The baseline after a Save, even a partial one: the fields it wrote now count
 * from what was written, so typing the old value back is a change again.
 */
export function baselineAfterSave(
  baseline: TicketEditValues,
  written: TicketEditValues,
  saved: readonly EditStep[],
): TicketEditValues {
  const out = { ...baseline };
  for (const key of saved.flatMap((s) => writtenKeys(s.action))) out[key] = written[key];
  return out;
}

/**
 * What the form refuses (D58): points that are not a number from 0 to the
 * maximum and labels longer than Jira takes, only in a field the user changed,
 * so an odd value already on the ticket never blocks a Save.
 */
export function editProblems(
  baseline: TicketEditValues,
  submitted: TicketEditValues,
): Partial<Record<"points" | "labels", string>> {
  const problems: Partial<Record<"points" | "labels", string>> = {};
  if (
    !sameValue("points", submitted.points, baseline.points) &&
    parsePointsInput(submitted.points) === undefined
  )
    problems.points = `Enter a number from 0 to ${MAX_STORY_POINTS}, or leave it empty`;
  if (
    !sameValue("labels", submitted.labels, baseline.labels) &&
    parseLabelsInput(submitted.labels).some((l) => l.length > MAX_LABEL_LENGTH)
  )
    problems.labels = `A label holds at most ${MAX_LABEL_LENGTH} characters`;
  return problems;
}

/** What one Save did: the steps written, the one that failed (with its error) and those not tried. */
export type EditOutcome<E = unknown> = {
  saved: EditStep[];
  failed: { step: EditStep; error: E } | null;
  skipped: EditStep[];
  /** False when a write succeeded but its re-fetch failed; the next sync repairs it. */
  refreshed: boolean;
};

/**
 * The toast for a Save (D58): what was saved, or what failed with what was
 * saved before it and what was not tried after it. `error` is the failure's
 * message, already made safe to show.
 */
export function editOutcomeText(
  issueKey: string,
  outcome: Pick<EditOutcome, "saved" | "failed" | "skipped">,
  error?: string,
): { title: string; description?: string } {
  const saved = partsText(outcome.saved);
  if (!outcome.failed) return { title: `Saved ${saved} on ${issueKey}` };
  const parts = [
    saved ? `Saved ${saved}.` : "Nothing was saved.",
    ...(outcome.skipped.length ? [`Not tried: ${partsText(outcome.skipped)}.`] : []),
    ...(error ? [error] : []),
  ];
  return {
    title: `Could not save ${partsText([outcome.failed.step])} on ${issueKey}`,
    description: parts.join(" "),
  };
}

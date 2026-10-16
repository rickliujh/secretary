/**
 * The Edit dialog's Sprint select (FR-17, D58): Backlog and the open sprints a
 * ticket can move to, from the synced sprint state, with the ticket's current
 * sprint selected.
 */
import { boardShowsProject } from "./active";
import type { SprintInfo } from "./calendar";
import { shortDay } from "./fit";

/** The value of the Backlog option. */
export const BACKLOG = "backlog";
/** The value of a current sprint that cannot be picked again (another board's, or a shared name). */
export const CURRENT = "current";

export type SprintOption = {
  /** BACKLOG, CURRENT, or the sprint id. */
  value: string;
  name: string;
  /** "active, ends Fri 17 Oct", "starts Mon 20 Oct", "closed"; empty for Backlog. */
  when: string;
  sprint: SprintInfo | null;
  /** False for a current sprint that is shown but cannot be picked again. */
  pickable: boolean;
};

export type SprintChoices =
  /** Epics do not move (the Executor refuses them); sub-tasks follow their parent. */
  | { kind: "none"; reason: "epic" | "subtask" }
  | {
      kind: "pick";
      options: SprintOption[];
      /** The selected option: the ticket's sprint as far as the cache tells. */
      value: string;
      /** The ticket's cached sprint name, if any. */
      current: string | null;
      /** A note under the select ("Last in PAY 14 (closed)"). */
      hint?: string;
    };

const isOpen = (s: SprintInfo) => s.state === "active" || s.state === "future";

/** "active, ends Fri 17 Oct" ("ended" once past), "starts Mon 20 Oct", "closed". */
export function sprintDates(s: SprintInfo, today: string): string {
  const end = s.end?.slice(0, 10) ?? null;
  const start = s.start?.slice(0, 10) ?? null;
  if (s.state === "active")
    return end ? `active, ${end < today ? "ended" : "ends"} ${shortDay(end)}` : "active";
  if (s.state === "future") return start ? `starts ${shortDay(start)}` : "future";
  if (s.state === "closed") return "closed";
  return s.state;
}

/**
 * The sprint options for a ticket: Backlog, then the open sprints whose board
 * shows its project (all open sprints when none does), active first, then
 * future by start. The current sprint (`jiraIssues.sprint`, a name; the cache
 * keeps no id) is matched by name:
 * - one offered sprint of that name is selected;
 * - a name only closed sprints have means the ticket is in the backlog: Backlog
 *   is selected, with a hint naming the closed sprint;
 * - a name two offered sprints share cannot tell which, and one that is not
 *   offered (another board's, or not known yet) cannot be picked again: either
 *   shows as the selected value, and every offered sprint stays pickable.
 * Without a current sprint, Backlog is selected. Epics and sub-tasks get none.
 */
export function sprintChoices(input: {
  sprints: readonly SprintInfo[];
  boardProjects: Readonly<Record<string, readonly string[]>>;
  projectKey: string;
  issueType: string;
  isSubtask: boolean;
  current: string | null;
  today: string;
}): SprintChoices {
  if (/^epic$/i.test(input.issueType.trim())) return { kind: "none", reason: "epic" };
  if (input.isSubtask) return { kind: "none", reason: "subtask" };
  const open = [...new Map(input.sprints.filter(isOpen).map((s) => [s.id, s])).values()];
  const onBoard = open.filter((s) => boardShowsProject(s, input.projectKey, input.boardProjects));
  const offered = (onBoard.length ? onBoard : open)
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        Number(b.s.state === "active") - Number(a.s.state === "active") ||
        (a.s.start ?? "￿").localeCompare(b.s.start ?? "￿") ||
        a.i - b.i,
    )
    .map(({ s }) => s);
  const options: SprintOption[] = [
    { value: BACKLOG, name: "Backlog", when: "", sprint: null, pickable: true },
    ...offered.map((s) => ({
      value: String(s.id),
      name: s.name,
      when: sprintDates(s, input.today),
      sprint: s,
      pickable: true,
    })),
  ];
  const current = input.current?.trim() || null;
  const pick = (value: string, extra: { hint?: string; shown?: SprintOption } = {}) =>
    ({
      kind: "pick",
      options: extra.shown ? [...options, extra.shown] : options,
      value,
      current,
      ...(extra.hint ? { hint: extra.hint } : {}),
    }) satisfies SprintChoices;
  if (!current) return pick(BACKLOG);
  const named = offered.filter((s) => s.name === current);
  const [only] = named;
  if (only && named.length === 1) return pick(String(only.id));
  const known = input.sprints.filter((s) => s.name === current);
  if (!named.length && known.length && known.every((s) => s.state === "closed"))
    return pick(BACKLOG, { hint: `Last in ${current} (closed)` });
  const other = known.find(isOpen) ?? null;
  const when = named.length
    ? `one of ${named.length} sprints of this name`
    : other
      ? `${sprintDates(other, input.today)}, its board does not show ${input.projectKey}`
      : "";
  return pick(CURRENT, {
    shown: { value: CURRENT, name: current, when, sprint: other, pickable: false },
  });
}

/**
 * The sprint whose room the dialog shows for the picked value (FR-17.3): an
 * active, pickable sprint other than the current value and not of the current
 * sprint's name, since the load already counts the ticket by that name.
 */
export function fitSprint(choices: SprintChoices | null, value: string): SprintInfo | null {
  if (choices?.kind !== "pick" || value === choices.value) return null;
  const picked = choices.options.find((o) => o.value === value);
  const s = picked?.pickable ? picked.sprint : null;
  return s?.state === "active" && s.name !== choices.current ? s : null;
}

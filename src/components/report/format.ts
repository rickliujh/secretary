/**
 * Pure helpers for the Report page (D37): the form's period and scope as a
 * request, the report as Markdown or plain text for pasting, and its tickets by
 * group.
 */
import type { List, ListItem, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";
import { shortDate } from "@/lib/time";
import type {
  Report,
  ReportGroup,
  ReportRequest,
  ReportSections,
  ReportTicket,
} from "@/services/report";

/** The period choices in the toggle group; "custom" reads the days field. */
export const PERIODS = [
  { value: "workday", label: "Since last working day" },
  { value: "3", label: "3 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "custom", label: "Custom" },
] as const;

export type PeriodChoice = (typeof PERIODS)[number]["value"];

const CustomDays = z.coerce.number().int().min(1).max(30);

export const ReportForm = z
  .object({
    period: z.enum(["workday", "3", "7", "14", "custom"]),
    /** The custom "Last N days" field, as typed. */
    days: z.string(),
    tracked: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.period === "custom" && (v.days.trim() === "" || !CustomDays.safeParse(v.days).success))
      ctx.addIssue({
        code: "custom",
        path: ["days"],
        message: "Enter a whole number of days from 1 to 30",
      });
  })
  .transform(
    (v): ReportRequest => ({
      period:
        v.period === "workday"
          ? { kind: "workday" }
          : { kind: "days", days: v.period === "custom" ? Number(v.days) : Number(v.period) },
      scope: v.tracked ? "mine_and_tracked" : "mine",
    }),
  );

export type ReportFormInput = z.input<typeof ReportForm>;

/** The prose sections under the summary, in reading order. */
export const SECTIONS: [Exclude<keyof ReportSections, "summary">, string][] = [
  ["done", "Done"],
  ["inProgress", "In progress"],
  ["changes", "Changes"],
  ["blockers", "Blockers"],
  ["next", "Next"],
];

/** The report as Markdown: a title line, the summary, then a `##` heading per non-empty section. */
export function reportMarkdown(r: Pick<Report, "periodLabel" | "sections">): string {
  const parts = [`# Update: ${r.periodLabel}`];
  const summary = r.sections.summary.trim();
  if (summary) parts.push(summary);
  for (const [key, title] of SECTIONS) {
    const text = r.sections[key].trim();
    if (text) parts.push(`## ${title}\n\n${text}`);
  }
  return parts.join("\n\n");
}

/** The report as plain text for a Teams chat or an email. */
export const reportText = (r: Pick<Report, "periodLabel" | "sections">): string =>
  markdownToText(reportMarkdown(r));

const phrasing = (nodes: PhrasingContent[]): string => nodes.map(phrase).join("");

function phrase(n: PhrasingContent): string {
  switch (n.type) {
    case "text":
    case "inlineCode":
      return n.value;
    case "break":
      return "\n";
    case "image":
      return n.alt ?? "";
    case "html":
    case "imageReference":
    case "footnoteReference":
      return "";
    case "link": {
      const text = phrasing(n.children);
      return text && text !== n.url ? `${text} (${n.url})` : n.url;
    }
    default:
      return "children" in n ? phrasing(n.children) : "";
  }
}

/** Lines of one list, nested items indented under their marker. */
function listLines(list: List): string[] {
  return list.children.flatMap((item: ListItem, i) => {
    const marker = list.ordered ? `${(list.start ?? 1) + i}. ` : "• ";
    const pad = " ".repeat(marker.length);
    return item.children
      .flatMap(blockLines)
      .map((line, j) => (j === 0 ? marker : line ? pad : "") + line);
  });
}

function blockLines(n: RootContent): string[] {
  switch (n.type) {
    case "heading":
    case "paragraph":
      return phrasing(n.children).split("\n");
    case "list":
      return listLines(n);
    case "blockquote":
      return n.children.flatMap(blockLines);
    case "code":
      return n.value.split("\n");
    case "table":
      return n.children.map((row) => row.children.map((c) => phrasing(c.children)).join(" | "));
    default:
      return [];
  }
}

/**
 * Markdown as plain text: headings on their own line, bullets as "• ", emphasis,
 * code and link syntax dropped (a link keeps its address in brackets). Blocks are
 * separated by a blank line, except that a section heading's content follows it
 * directly; a top-level title keeps its blank line.
 */
export function markdownToText(md: string): string {
  const out: string[] = [];
  let afterHeading = false;
  for (const node of fromMarkdown(md).children) {
    const lines = blockLines(node);
    if (lines.length === 0) continue;
    if (out.length > 0 && !afterHeading) out.push("");
    out.push(...lines);
    afterHeading = node.type === "heading" && node.depth > 1;
  }
  return out.join("\n").trim();
}

/** "3 Sep 2026 → 26 Sep 2026", or one date when the period starts and ends on the same day. */
export function dateRange(since: string, until: string): string {
  const a = shortDate(since);
  const b = shortDate(until);
  return a === b ? a : `${a} → ${b}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The stats row's badge texts. */
export function statLabels(s: Report["stats"]): string[] {
  return [
    s.pointsDone > 0 ? `${s.done} done · ${plural(s.pointsDone, "point")}` : `${s.done} done`,
    `${s.inProgress} in progress`,
    `${s.new} new`,
    plural(s.comments, "comment"),
  ];
}

export const GROUPS: [ReportGroup, string][] = [
  ["done", "Done"],
  ["in_progress", "In progress"],
  ["new", "New"],
  ["changed", "Changed"],
  ["blocked", "Blocked"],
  ["next", "Next"],
];

/** Tickets by group, in the order above, leaving out empty groups. */
export const groupTickets = (tickets: ReportTicket[]) =>
  GROUPS.map(([group, label]) => ({
    group,
    label,
    tickets: tickets.filter((t) => t.group === group),
  })).filter((g) => g.tickets.length > 0);

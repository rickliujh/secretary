/**
 * Pure helpers for the Report page (D37): the form's period and scope as a
 * request, Markdown as plain text for pasting, and the header's date range and
 * stats. The report's Markdown itself comes from `render.ts`.
 */
import type { List, ListItem, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";
import { shortDate } from "@/lib/time";
import type { Report, ReportRequest } from "@/services/report";

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
 * directly (the title, the document's top heading level, keeps its blank line), and a block written on the
 * line right after the previous one (a bold line, then its list) stays tight.
 */
export function markdownToText(md: string): string {
  const nodes = fromMarkdown(md).children;
  const top = Math.min(...nodes.map((n) => (n.type === "heading" ? n.depth : 7)));
  const out: string[] = [];
  let tight = false;
  let endLine = -1;
  for (const node of nodes) {
    const lines = blockLines(node);
    if (lines.length === 0) continue;
    const adjacent = node.position?.start.line === endLine + 1;
    if (out.length > 0 && !tight && !adjacent) out.push("");
    out.push(...lines);
    tight = node.type === "heading" && node.depth > top;
    endLine = node.position?.end.line ?? -1;
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

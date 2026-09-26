import { ClipboardCopy, Copy, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useSettings, useUpdateSettings } from "@/app/hooks";
import { Markdown } from "@/components/markdown";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { relativeTime } from "@/lib/time";
import { REPORT_STYLES, type Report, type ReportStyle } from "@/services/report";
import { dateRange, markdownToText, statLabels } from "./format";
import { renderReport, STYLE_LABELS } from "./render";
import { useCopy } from "./use-report";

const isStyle = (v: string): v is ReportStyle => (REPORT_STYLES as readonly string[]).includes(v);

/**
 * The style the report reads in (D39): the saved setting, switched instantly on
 * screen and saved in the background.
 */
function useReportStyle() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const [picked, setPicked] = useState<ReportStyle | null>(null);
  const style = picked ?? settings?.report.style ?? "talk_track";
  const change = (next: ReportStyle) => {
    setPicked(next);
    update.mutate((s) => ({ ...s, report: { ...s.report, style: next } }));
  };
  return [style, change] as const;
}

/** A written report: stats, the style picker, and the report in that style. */
export function ReportView({ report }: { report: Report }) {
  const copy = useCopy();
  const [style, setStyle] = useReportStyle();
  const markdown = useMemo(() => renderReport(report, style), [report, style]);
  const missing = report.historyMissing.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{report.periodLabel}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2">
          <span>{dateRange(report.since, report.until)}</span>
          <span>
            ·{" "}
            {report.sprintScope?.length
              ? `${report.sprintScope.join(", ")} only`
              : "All sprints and backlog"}
          </span>
          <span>· Written {relativeTime(report.generatedAt)}</span>
          {report.model && <span>· {report.model}</span>}
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={copy.isPending}
            onClick={() => copy.mutate(markdown)}
          >
            <Copy /> Copy
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={copy.isPending}
            onClick={() => copy.mutate(markdownToText(markdown))}
          >
            <ClipboardCopy /> Copy as text
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {statLabels(report.stats).map((s) => (
            <Badge key={s} variant="secondary" className="tabular-nums">
              {s}
            </Badge>
          ))}
        </div>
        {missing > 0 && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>
              Jira history could not be read for {missing} ticket{missing === 1 ? "" : "s"}; their
              changes come from the local copy only.
            </AlertDescription>
          </Alert>
        )}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={style}
          onValueChange={(v) => isStyle(v) && v !== style && setStyle(v)}
          className="flex-wrap"
          aria-label="Report style"
        >
          {REPORT_STYLES.map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {STYLE_LABELS[s]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Markdown linkTickets>{markdown}</Markdown>
      </CardContent>
    </Card>
  );
}

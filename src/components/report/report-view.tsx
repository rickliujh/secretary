import { ChevronRight, ClipboardCopy, Copy, TriangleAlert } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { TicketLink } from "@/components/tickets/ticket-link";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { relativeTime } from "@/lib/time";
import type { Report } from "@/services/report";
import {
  dateRange,
  groupTickets,
  reportMarkdown,
  reportText,
  SECTIONS,
  statLabels,
} from "./format";
import { useCopy } from "./use-report";

/** A written report: stats, the prose sections, and the tickets it is based on. */
export function ReportView({ report }: { report: Report }) {
  const copy = useCopy();
  const missing = report.historyMissing.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{report.periodLabel}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2">
          <span>{dateRange(report.since, report.until)}</span>
          <span>· Written {relativeTime(report.generatedAt)}</span>
          {report.model && <span>· {report.model}</span>}
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={copy.isPending}
            onClick={() => copy.mutate(reportMarkdown(report))}
          >
            <Copy /> Copy
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={copy.isPending}
            onClick={() => copy.mutate(reportText(report))}
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
        {report.sections.summary.trim() && (
          <Markdown linkTickets className="text-base">
            {report.sections.summary}
          </Markdown>
        )}
        {SECTIONS.filter(([key]) => report.sections[key].trim()).map(([key, title]) => (
          <section key={key}>
            <h3 className="mb-1 text-sm font-medium">{title}</h3>
            <Markdown linkTickets>{report.sections[key]}</Markdown>
          </section>
        ))}
        {report.tickets.length > 0 && <BasedOn tickets={report.tickets} />}
      </CardContent>
    </Card>
  );
}

/** The tickets behind the prose, by group, collapsed by default. */
function BasedOn({ tickets }: { tickets: Report["tickets"] }) {
  return (
    <Collapsible className="border-t pt-3">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group -ml-2 text-muted-foreground">
          <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
          Based on {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-3">
        {groupTickets(tickets).map((g) => (
          <section key={g.group}>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">{g.label}</h4>
            <ul className="flex flex-col gap-1">
              {g.tickets.map((t) => (
                <li key={t.key} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <TicketLink ticketKey={t.key} />
                  <span className="min-w-0">{t.summary}</span>
                  <Badge variant="outline" className="text-xs">
                    {t.status}
                  </Badge>
                  {t.points !== null && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t.points} pt
                    </span>
                  )}
                  {t.notes.length > 0 && (
                    <span className="text-xs text-muted-foreground">{t.notes.join("; ")}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

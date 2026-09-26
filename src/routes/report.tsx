import { createFileRoute } from "@tanstack/react-router";
import { NotebookPen, RefreshCw } from "lucide-react";
import { describeError } from "@/app/errors";
import { EmptyState, PageHeader } from "@/components/page";
import { ReportControls } from "@/components/report/report-controls";
import { ReportView } from "@/components/report/report-view";
import { useLastReport, useWriteReport } from "@/components/report/use-report";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/report")({ component: ReportPage });

/** Recap for stand-ups and catch-ups (design.md D37). */
function ReportPage() {
  const last = useLastReport();
  const write = useWriteReport();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Report"
        description="A recap of what was done, what moved and what is next, for stand-ups and catch-ups."
      />
      <ReportControls pending={write.isPending} onWrite={(req) => write.mutate(req)} />
      {last.isPending ? (
        <Skeleton className="h-72" />
      ) : last.isError ? (
        <EmptyState
          icon={NotebookPen}
          title={describeError(last.error).title}
          description={describeError(last.error).description ?? "The last report could not load."}
          action={
            <Button variant="outline" onClick={() => void last.refetch()}>
              <RefreshCw /> Retry
            </Button>
          }
        />
      ) : last.data ? (
        <ReportView report={last.data} />
      ) : (
        <EmptyState
          icon={NotebookPen}
          title="No report yet"
          description="Pick a period and press Write report for a recap of your tickets to read out at a stand-up or catch-up meeting: what got done, what is in progress, what changed, what is blocked and what comes next."
        />
      )}
    </div>
  );
}

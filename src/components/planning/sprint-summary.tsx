import { CalendarPlus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/time";
import type { PlanPrep, SprintRef } from "@/services/planning";

const dates = (s: SprintRef) =>
  s.start && s.end
    ? `${shortDate(s.start)} to ${shortDate(s.end)}`
    : s.end
      ? `ends ${shortDate(s.end)}`
      : "no dates set";

/** The ending sprint, the user's work in it, and the sprint being planned. */
export function SprintSummary({ prep }: { prep: PlanPrep }) {
  const { ending, next, endingSummary: sum } = prep;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{ending ? ending.name : "No active sprint"}</CardTitle>
        <CardDescription>
          {ending
            ? ending.end
              ? `Ends ${shortDate(ending.end)}`
              : "No end date"
            : "None of your work is in an active sprint."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {sum && (
          <p>
            You finished <span className="font-medium tabular-nums">{sum.done}</span> of{" "}
            <span className="tabular-nums">{sum.committed}</span> committed points;{" "}
            <span className="tabular-nums">{sum.open}</span> issue{sum.open === 1 ? "" : "s"} still
            open
            {sum.unestimated > 0 && (
              <>
                , <span className="tabular-nums">{sum.unestimated}</span> unestimated
              </>
            )}
            .
          </p>
        )}
        {next ? (
          <p>
            Planning <span className="font-medium">{next.name}</span>
            <span className="text-muted-foreground">, {dates(next)}</span>
          </p>
        ) : (
          <Alert>
            <CalendarPlus />
            <AlertTitle>No next sprint yet</AlertTitle>
            <AlertDescription>
              Create the next sprint in Jira first; you can still draft a plan.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

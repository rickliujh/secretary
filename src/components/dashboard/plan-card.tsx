import { Link } from "@tanstack/react-router";
import { CalendarRange } from "lucide-react";
import { planningDue } from "@/components/planning/plan";
import { usePlanPrep } from "@/components/planning/use-planning";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { localDate, localDateOf } from "@/lib/dates";
import { shortDate } from "@/lib/time";

const PREP_STALE_MS = 10 * 60_000;

/**
 * Suggests planning when the sprint is about to end (design.md D30). Quiet on
 * any error: the Planning page explains those.
 */
export function PlanCard() {
  const prep = usePlanPrep({ staleTime: PREP_STALE_MS });
  const p = prep.data;
  if (!p || !planningDue(p, localDate())) return null;
  const end = p.ending.end;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{p.next ? `Plan ${p.next.name}` : "Plan the next sprint"}</CardTitle>
        <CardDescription>
          {p.ending.name} {end && localDateOf(end) < localDate() ? "ended" : "ends"}
          {end ? ` ${shortDate(end)}` : ""}.
        </CardDescription>
        <CardAction>
          <Button asChild size="sm">
            <Link to="/planning">
              <CalendarRange /> Plan
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

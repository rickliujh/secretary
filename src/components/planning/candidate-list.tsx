import { Link } from "@tanstack/react-router";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { type Candidate, pointsOf } from "@/services/planning";
import { GROUP_LABELS, GROUP_ORDER } from "./plan";

/** The model's plan as the list needs it; null before a draft. */
export type ReviewState = {
  checked: ReadonlySet<string>;
  onToggle: (key: string, on: boolean) => void;
  picks: ReadonlyMap<string, { rank: number; reason: string }>;
  deferred: ReadonlyMap<string, string>;
};

function CandidateRow({ c, review }: { c: Candidate; review: ReviewState | null }) {
  const pick = review?.picks.get(c.key);
  const deferred = review?.deferred.get(c.key);
  const checked = review?.checked.has(c.key) ?? false;
  return (
    <li className={cn("flex gap-3 py-2", review && !checked && "opacity-70")}>
      {review && (
        <Checkbox
          className="mt-0.5"
          checked={checked}
          onCheckedChange={(v) => review.onToggle(c.key, v === true)}
          aria-label={`Take ${c.key} into the sprint`}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2 text-sm">
          <Link to="/tickets" search={{ key: c.key }} className="font-mono text-xs underline">
            {c.key}
          </Link>
          <span className="min-w-0 flex-1 truncate" title={c.summary}>
            {c.summary}
          </span>
          {c.priority && <span className="text-xs text-muted-foreground">{c.priority}</span>}
          {c.dueInSprint && c.dueDate && (
            <Badge variant="secondary" className={cn("border-transparent", TONE.warning)}>
              due {shortDate(c.dueDate)}
            </Badge>
          )}
          {c.blocked.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className={cn("border-transparent", TONE.danger)}>
                  blocked
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <ul>
                  {c.blocked.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
          {c.points === null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-muted-foreground">
                  ?
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Unestimated</TooltipContent>
            </Tooltip>
          ) : (
            <Badge variant="outline" className="tabular-nums">
              {c.points} pt
            </Badge>
          )}
        </div>
        {pick && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">#{pick.rank}</span> {pick.reason}
          </p>
        )}
        {deferred && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Deferred:</span> {deferred}
          </p>
        )}
      </div>
    </li>
  );
}

/** Candidates grouped the way the planner built them (design.md D30). */
export function CandidateList({
  candidates,
  review,
}: {
  candidates: readonly Candidate[];
  review: ReviewState | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {GROUP_ORDER.map((group) => {
        const items = candidates.filter((c) => c.group === group);
        if (items.length === 0) return null;
        const { total, unestimated } = pointsOf(
          items,
          items.map((c) => c.key),
        );
        return (
          <section key={group} className="flex flex-col gap-1">
            <h3 className="flex items-baseline gap-2 text-sm font-medium">
              {GROUP_LABELS[group]}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {items.length} issue{items.length === 1 ? "" : "s"}, {total} pt
                {unestimated.length > 0 && `, ${unestimated.length} unestimated`}
              </span>
            </h3>
            <ul className="divide-y">
              {items.map((c) => (
                <CandidateRow key={c.key} c={c} review={review} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

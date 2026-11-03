/**
 * The work line above a draft (FR-19.8, D62): when the draft's ticket belongs
 * to a work item, where that item stands and its first next moves, so the
 * message can say what is true. Hidden while suggestions are off.
 */
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { NextMoves } from "@/components/work/next-moves";
import { localDate } from "@/lib/dates";
import { shortDate } from "@/lib/time";
import { workOfKeys } from "@/services/work/next-query";

/** Moves shown above a draft: a few, the editor is the point. */
const DRAFT_MOVES = 3;

export function WorkLine({ issueKeys }: { issueKeys: readonly string[] }) {
  const { data: settings } = useSettings();
  const on = (settings?.secretary.suggestions ?? false) && (settings?.work.enabled ?? false);
  const today = localDate();
  const work = useQuery({
    queryKey: queryKeys.workOfKeys(issueKeys, today),
    queryFn: ({ signal }) => run(workOfKeys(issueKeys, today), signal),
    enabled: on && issueKeys.length > 0,
  });
  const w = work.data;
  if (!on || !w) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {w.current && <Star className="size-3.5 fill-current" aria-label="You're on this" />}
        <span className="font-medium">{w.name}</span>
        {w.currentStep && <span className="text-muted-foreground">Now: {w.currentStep}</span>}
        {w.nextExpected && (
          <span className="text-muted-foreground">
            Next expected: {w.nextExpected.what}
            {w.nextExpected.on ? ` (${shortDate(w.nextExpected.on)})` : ""}
          </span>
        )}
      </p>
      <NextMoves moves={w.moves.slice(0, DRAFT_MOVES)} />
    </section>
  );
}

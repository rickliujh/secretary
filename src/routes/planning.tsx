import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  CalendarRange,
  Inbox,
  ListChecks,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { describeError, isInterrupted, isSyncBusy } from "@/app/errors";
import { useErrorToast } from "@/app/hooks";
import { runSync } from "@/app/sync";
import { EmptyState, PageHeader } from "@/components/page";
import { CandidateList, type ReviewState } from "@/components/planning/candidate-list";
import {
  capacityPercent,
  capacityTone,
  parseCapacity,
  proposedMessage,
  toProposal,
} from "@/components/planning/plan";
import { PlanError } from "@/components/planning/plan-error";
import { SprintSummary } from "@/components/planning/sprint-summary";
import { useDraftPlan, usePlanPrep, useProposePlan } from "@/components/planning/use-planning";
import { TONE, type Tone } from "@/components/tone";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type PlanDraft, PlanningError, type PlanPrep, pointsOf } from "@/services/planning";

export const Route = createFileRoute("/planning")({ component: PlanningPage });

const DraftForm = z.object({
  capacity: z
    .string()
    .refine((v) => v.trim() === "" || parseCapacity(v) !== null, "Enter points, or leave it empty")
    .transform(parseCapacity),
  note: z.string(),
});

const ReviewForm = z.object({
  goal: z.string().trim().min(1, "Give the sprint a goal"),
  picks: z.array(z.string()).min(1, "Check at least one issue"),
});
type ReviewValues = z.infer<typeof ReviewForm>;

/** The capacity bar's fill colour by tone. */
const BAR: Record<Tone, string> = {
  success: "*:data-[slot=progress-indicator]:bg-emerald-500",
  warning: "*:data-[slot=progress-indicator]:bg-amber-500",
  danger: "*:data-[slot=progress-indicator]:bg-destructive",
  info: "",
  neutral: "",
};

const Header = () => (
  <PageHeader
    title="Planning"
    description="Choose what to take into the next sprint, sized against what you usually finish."
  />
);

/** Sprint planning (design.md D30). */
function PlanningPage() {
  const prep = usePlanPrep();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <Header />
      {prep.isPending ? (
        <PlanningSkeleton />
      ) : prep.isError ? (
        <PrepError error={prep.error} retry={() => void prep.refetch()} />
      ) : prep.data.candidates.length === 0 ? (
        <NothingToPlan />
      ) : (
        <Planner prep={prep.data} />
      )}
    </div>
  );
}

function PlanningSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-36" />
        <Skeleton className="h-64" />
      </div>
      <div className="flex flex-col gap-2 lg:col-span-2">
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders never reorder.
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    </div>
  );
}

const NothingToPlan = () => (
  <EmptyState
    icon={ListChecks}
    title="Nothing to plan"
    description="No open work of yours: nothing unfinished, planned or in your backlog."
  />
);

function PrepError({ error, retry }: { error: unknown; retry: () => void }) {
  const onError = useErrorToast();
  const [syncing, setSyncing] = useState(false);
  const kind = error instanceof PlanningError ? error.kind : null;
  if (kind === "no_candidates") return <NothingToPlan />;
  if (kind === "no_user") {
    const sync = () => {
      setSyncing(true);
      runSync()
        .then(retry, (e) => {
          if (!isSyncBusy(e)) onError(e, sync);
        })
        .finally(() => setSyncing(false));
    };
    return (
      <EmptyState
        icon={RefreshCw}
        title="Sync Jira first"
        description="The planner needs your Jira user, sprints and issues."
        action={
          <Button onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Sync now
          </Button>
        }
      />
    );
  }
  const d = describeError(error);
  return (
    <EmptyState
      icon={CalendarRange}
      title={d.title}
      description={d.description ?? "The planner could not load."}
      action={
        <Button variant="outline" onClick={retry}>
          <RefreshCw /> Retry
        </Button>
      }
    />
  );
}

function Planner({ prep }: { prep: PlanPrep }) {
  const navigate = useNavigate();
  const draft = useDraftPlan();
  const [notes, setNotes] = useState<string[]>([]);
  // The latest plan stays on screen while a rewrite runs or fails.
  const [drafted, setDrafted] = useState<{ prep: PlanPrep; plan: PlanDraft } | null>(null);
  const form = useForm<z.input<typeof DraftForm>, unknown, z.output<typeof DraftForm>>({
    resolver: zodResolver(DraftForm),
    defaultValues: { capacity: prep.capacity === null ? "" : String(prep.capacity), note: "" },
  });
  const review = useForm<ReviewValues>({
    resolver: zodResolver(ReviewForm),
    defaultValues: { goal: "", picks: [] },
  });
  const propose = useProposePlan({
    success: proposedMessage,
    onSuccess: (r) => void navigate({ to: "/inbox", search: { item: r.inboxItemId } }),
  });

  const note = useWatch({ control: form.control, name: "note" });
  const capacity = parseCapacity(useWatch({ control: form.control, name: "capacity" }));
  const picked = useWatch({ control: review.control, name: "picks" });

  const plan = drafted?.plan ?? null;
  // A draft carries a fresh look at the sprint; before it, the page's own.
  const current = drafted?.prep ?? prep;
  const candidates = current.candidates;
  const candidateKeys = useMemo(() => candidates.map((c) => c.key), [candidates]);

  const reviewState = useMemo<ReviewState | null>(() => {
    if (!plan) return null;
    return {
      checked: new Set(picked),
      onToggle: (key, on) =>
        review.setValue(
          "picks",
          on ? [...picked.filter((k) => k !== key), key] : picked.filter((k) => k !== key),
          { shouldValidate: review.formState.isSubmitted },
        ),
      picks: new Map(plan.picks.map((p, i) => [p.key, { rank: i + 1, reason: p.reason }])),
      deferred: new Map(plan.deferred.map((d) => [d.key, d.reason])),
    };
  }, [plan, picked, review]);

  const submitDraft = form.handleSubmit((v) => {
    const text = v.note.trim();
    const instructions = text ? [...notes, text] : notes;
    draft.mutate(
      { capacity: v.capacity, instructions },
      {
        onSuccess: (r) => {
          setNotes(instructions);
          setDrafted(r);
          form.setValue("note", "");
          review.reset({ goal: r.plan.goal, picks: r.plan.picks.map((p) => p.key) });
          propose.reset();
        },
      },
    );
  });

  const submitPlan = review.handleSubmit((v) => {
    if (!plan) return;
    propose.mutate(toProposal({ goal: v.goal, checked: new Set(v.picks), candidateKeys, plan }));
  });

  const draftLabel = !plan
    ? "Draft a plan"
    : note.trim()
      ? "Rewrite with this note"
      : "Draft again";

  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4">
        <SprintSummary prep={current} />
        <Card size="sm">
          <CardHeader>
            <CardTitle>Your plan's inputs</CardTitle>
            <CardDescription>The model picks only from the issues listed here.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitDraft} className="flex flex-col gap-4">
              <FieldGroup>
                <Field data-invalid={!!form.formState.errors.capacity}>
                  <FieldLabel htmlFor="plan-capacity">Capacity (story points)</FieldLabel>
                  <Input
                    id="plan-capacity"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    placeholder="Unknown"
                    className="w-32"
                    {...form.register("capacity")}
                  />
                  <FieldError errors={[form.formState.errors.capacity]} />
                  <Velocity prep={current} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="plan-note">Anything to keep in mind?</FieldLabel>
                  <Textarea
                    id="plan-note"
                    rows={3}
                    placeholder={`"Friday is a release freeze", "I'm out Monday"`}
                    {...form.register("note")}
                  />
                  {notes.length > 0 && (
                    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {notes.map((n, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: notes can repeat; order is stable.
                        <li key={i} className="flex items-start gap-1">
                          <span className="min-w-0 flex-1 whitespace-pre-wrap">{n}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-5"
                            aria-label="Forget this note"
                            onClick={() => setNotes(notes.filter((_, j) => j !== i))}
                          >
                            <X />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <FieldDescription>
                    Notes are kept for every later draft until you remove them.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <div className="flex gap-2">
                <Button type="submit" disabled={draft.isPending}>
                  {draft.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  {draft.isPending ? "Drafting..." : draftLabel}
                </Button>
                {draft.isPending && (
                  <Button type="button" variant="outline" onClick={draft.cancel}>
                    Cancel
                  </Button>
                )}
              </div>
              {draft.isError && !isInterrupted(draft.error) && <PlanError error={draft.error} />}
            </form>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-col gap-4 lg:col-span-2">
        {plan && (
          <Card size="sm">
            <CardHeader>
              <CardTitle>The plan</CardTitle>
              <CardDescription>
                Check or uncheck anything below, then send the moves to the Inbox to approve.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitPlan} className="flex flex-col gap-4">
                <Field data-invalid={!!review.formState.errors.goal}>
                  <FieldLabel htmlFor="plan-goal">Sprint goal</FieldLabel>
                  <Input id="plan-goal" {...review.register("goal")} />
                  <FieldError errors={[review.formState.errors.goal]} />
                </Field>
                <Load candidates={candidates} picked={picked} capacity={capacity} />
                <FieldError errors={[review.formState.errors.picks]} />
                {plan.risks.length > 0 && (
                  <Alert>
                    <AlertTitle>Risks</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {plan.risks.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
                <div>
                  <Button type="submit" disabled={propose.isPending}>
                    {propose.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                    Send to Inbox for approval
                  </Button>
                </div>
                {propose.isError && <PlanError error={propose.error} />}
              </form>
            </CardContent>
          </Card>
        )}
        <Card size="sm">
          <CardHeader>
            <CardTitle>Candidates</CardTitle>
            <CardDescription>
              {plan
                ? "Checked issues go into the sprint; the model's reasons are under its picks."
                : "What the planner will choose from. Draft a plan to pick among them."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CandidateList candidates={candidates} review={reviewState} />
          </CardContent>
        </Card>
        {plan && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Inbox className="size-3.5" />
            Nothing changes in Jira until you approve each move in the Inbox.
          </p>
        )}
      </div>
    </div>
  );
}

/** Where the default capacity comes from. */
function Velocity({ prep }: { prep: PlanPrep }) {
  const { sprints, average } = prep.velocity;
  if (sprints.length === 0)
    return (
      <FieldDescription>
        No closed sprints to learn from. Enter what you expect to finish, or leave it empty.
      </FieldDescription>
    );
  return (
    <FieldDescription className="flex flex-col gap-1">
      <span>
        You finished {average ?? 0} points on average in your last {sprints.length} sprint
        {sprints.length === 1 ? "" : "s"}:
      </span>
      <span className="flex flex-col">
        {sprints.map((s) => (
          <span key={s.name} className="tabular-nums">
            {s.name}: {s.points} pt in {s.issues} issue{s.issues === 1 ? "" : "s"}
            {s.unestimated > 0 && `, ${s.unestimated} unestimated`}
          </span>
        ))}
      </span>
    </FieldDescription>
  );
}

/** Checked points against capacity, recomputed as the user edits the plan. */
function Load({
  candidates,
  picked,
  capacity,
}: {
  candidates: PlanPrep["candidates"];
  picked: string[];
  capacity: number | null;
}) {
  const { total, unestimated } = pointsOf(candidates, picked);
  const tone = capacityTone(total, capacity);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="secondary" className={cn("border-transparent tabular-nums", TONE[tone])}>
          {capacity === null ? `${total} points` : `${total} of ${capacity} points`}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {picked.length} issue{picked.length === 1 ? "" : "s"}
          {unestimated.length > 0 && `, ${unestimated.length} unestimated`}
          {capacity === null && "; capacity unknown"}
          {tone === "warning" && "; over capacity"}
          {tone === "danger" && "; well over capacity"}
        </span>
      </div>
      {capacity !== null && (
        <Progress value={capacityPercent(total, capacity)} className={cn("h-2", BAR[tone])} />
      )}
    </div>
  );
}

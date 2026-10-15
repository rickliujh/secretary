/**
 * New tickets and the sprint (FR-16, D57): the switch that adds a create to the
 * user's active sprint, whether the sprint has room, and the details behind it.
 * The switch saves at once (`Proposals.saveEdit`) and marks the value chosen,
 * so revisions keep it; Approve stays one click.
 */
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import type { ProposalView } from "@/services/inbox/queries";
import type { PayloadOf } from "@/services/proposals/schema";
import { isSubtaskType } from "@/services/small-asks/home";
import type { Fit, Verdict } from "@/services/sprints/fit";
import type { CreateSprintFit } from "@/services/sprints/fit-query";
import { useDecisions, usePendingEdit, useSavingEdit, useTurnRunning } from "./use-inbox";
import { useThreadSprintFits } from "./use-sprint-fit";

const VERDICT_TEXT: Record<Verdict, string> = {
  fits: "text-muted-foreground",
  tight: "text-amber-700 dark:text-amber-300",
  over: "text-destructive",
  unknown: "text-muted-foreground",
};

const VERDICT_DOT: Record<Verdict, string> = {
  fits: "bg-muted-foreground/60",
  tight: "bg-amber-500",
  over: "bg-destructive",
  unknown: "border border-muted-foreground/60",
};

export function VerdictDot({ verdict, className }: { verdict: Verdict; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", VERDICT_DOT[verdict], className)}
    />
  );
}

/** The details behind a verdict: the load, the other new tickets, this one and the rate. */
export function FitDetails({ fit, sprint }: { fit: Fit; sprint?: { name: string; when: string } }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {sprint && (
        <p className="font-medium">
          {sprint.name} <span className="font-normal text-muted-foreground">({sprint.when})</span>
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {fit.details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Days off, holidays and remaining estimates are not counted.{" "}
        <Link to="/settings" search={{ tab: "general" }} className="underline">
          {fit.rate?.source === "settings" ? "Change" : "Set"} what a point means
        </Link>
      </p>
    </div>
  );
}

/** The verdict line with its Details popover. */
export function VerdictLine({
  fit,
  sprint,
  className,
}: {
  fit: Fit;
  sprint?: { name: string; when: string };
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 text-xs", className)}>
      <span className={VERDICT_TEXT[fit.verdict]}>{fit.headline}</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="link" size="sm" className="h-auto p-0 text-xs">
            Details
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <FitDetails fit={fit} sprint={sprint} />
        </PopoverContent>
      </Popover>
      {fit.missing === "rate" && (
        <Link to="/settings" search={{ tab: "general" }} className="underline">
          Set what a point means
        </Link>
      )}
    </div>
  );
}

/**
 * Whether a create can never join from its own payload, while the fit is not
 * known: an Epic, or a sub-task (a parent, or a sub-task type by name).
 */
const neverJoins = (p: PayloadOf<"create_issue">) =>
  /^epic$/i.test(p.issueType.trim()) || !!p.parent || isSubtaskType(p.issueType);

/**
 * The create's switch (D57). What it shows is the stored proposal, or an edit
 * of it still being saved from any component (a card, its dialog, the
 * small-ask row), so two switches never disagree. It is locked while a save
 * or an intake turn on the thread runs, so a toggle is not lost to a row the
 * turn replaces.
 */
export function useSprintSwitch(proposal: ProposalView) {
  const { saveEdit } = useDecisions();
  const payload = (proposal.editedPayload ?? proposal.payload) as PayloadOf<"create_issue">;
  const fits = useThreadSprintFits(proposal.inboxItemId, proposal.kind === "create_issue");
  const saving = useSavingEdit({ id: proposal.id });
  const turn = useTurnRunning(proposal.inboxItemId);
  const pendingEdit = usePendingEdit(proposal.id);
  const checked =
    pendingEdit?.kind === "create_issue" ? pendingEdit.joinSprint : payload.joinSprint;
  const set = (joinSprint: boolean) => {
    if (proposal.status !== "pending") return;
    saveEdit.mutate({
      id: proposal.id,
      inboxItemId: proposal.inboxItemId,
      edited: { ...payload, joinSprint, joinSprintChosen: true },
    });
  };
  const choice: CreateSprintFit | undefined = fits.data?.[proposal.id];
  return {
    choice,
    /** Reading the fit, or it failed: the switch still shows (and, on failure, works). */
    loading: fits.isPending && fits.fetchStatus !== "idle",
    failed: fits.isError,
    checked,
    set,
    busy: saving || turn,
    payload,
  };
}

/**
 * The Sprint row of a create's card (`layout` card: a term and its value) and
 * of its edit dialog: the switch, the verdict and Details. Nothing for an Epic
 * or a sub-task, which never join.
 */
export function SprintSwitch({
  proposal,
  layout,
}: {
  proposal: ProposalView;
  layout: "card" | "dialog";
}) {
  const sw = useSprintSwitch(proposal);
  if (sw.choice ? sw.choice.kind === "never" : neverJoins(sw.payload)) return null;
  if (!sw.choice && !sw.loading && !sw.failed) return null;
  const body = <SprintSwitchBody proposal={proposal} sw={sw} />;
  return layout === "card" ? (
    <>
      <dt className="text-muted-foreground">Sprint</dt>
      <dd className="min-w-0">{body}</dd>
    </>
  ) : (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Sprint</span>
      {body}
    </div>
  );
}

function SprintSwitchBody({
  proposal,
  sw,
}: {
  proposal: ProposalView;
  sw: ReturnType<typeof useSprintSwitch>;
}) {
  const id = useId();
  const { choice, checked, set, busy, payload } = sw;
  const locked = busy || proposal.status !== "pending";
  const control = (label: string, disabled: boolean) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Switch id={id} size="sm" checked={checked} disabled={disabled} onCheckedChange={set} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      {choice?.kind === "sprint" && (
        <span className="text-xs text-muted-foreground">{choice.sprint.when}</span>
      )}
    </div>
  );
  // While the fit is read: the stored choice, not yet changeable.
  if (!choice && sw.loading)
    return control(checked ? "Joins your active sprint" : "Stays in the backlog", true);
  // The fit could not be read: the choice still works.
  if (!choice)
    return (
      <div className="flex flex-col gap-1">
        {control("Add to your active sprint", locked)}
        <p className="text-xs text-muted-foreground">Can't check the sprint's room</p>
      </div>
    );
  if (choice.kind === "never") return null;
  if (choice.kind === "no_sprint")
    return <span className="text-muted-foreground">No active sprint; it goes to the backlog</span>;
  const { sprint, fit, offBoard } = choice;
  return (
    <div className="flex flex-col gap-1">
      {control(`Add to ${sprint.name}`, locked)}
      {offBoard && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          That sprint's board does not show {payload.projectKey}, so the ticket will not appear on
          it.
        </p>
      )}
      <VerdictLine fit={fit} sprint={sprint} />
    </div>
  );
}

/** Where an executed create went, from its result (D57). */
export function sprintOutcome(result: unknown): string {
  const r = (result ?? {}) as { sprint?: string; message?: string };
  const named = r.sprint ?? / in sprint (.+)$/.exec(r.message ?? "")?.[1];
  return named ? `Added to sprint ${named}` : "In the backlog";
}

/**
 * The small-ask row's compact choice (D57): a "Sprint" toggle with the verdict
 * dot, and the same details one click away. `checked` and `onChange` belong to
 * the row, which saves its fields together. While the fit is read the toggle
 * waits; when it cannot be read the toggle still works.
 */
export function SprintChip({
  choice,
  loading,
  failed,
  checked,
  onChange,
  disabled,
}: {
  choice: CreateSprintFit | undefined;
  loading?: boolean;
  failed?: boolean;
  checked: boolean;
  onChange: (joinSprint: boolean) => void;
  disabled?: boolean;
}) {
  if (choice?.kind === "never") return null;
  if (choice?.kind === "no_sprint")
    return <span className="text-xs text-muted-foreground">No active sprint</span>;
  if (!choice && !loading && !failed) return null;
  const sprint = choice?.sprint;
  const fit = choice?.fit;
  const unread = loading ? "Checking the sprint's room" : "Can't check the sprint's room";
  return (
    <span className="inline-flex items-center">
      <Toggle
        size="sm"
        variant="outline"
        pressed={checked}
        disabled={disabled || (!choice && loading)}
        onPressedChange={onChange}
        aria-label={sprint ? `Add to ${sprint.name}` : "Add to your active sprint"}
        title={sprint ? `Add to ${sprint.name}, ${sprint.when}` : unread}
        className={cn(fit && "rounded-r-none")}
      >
        Sprint
      </Toggle>
      {fit && sprint && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-l-none border-l-0 px-2"
              aria-label={`Sprint room: ${fit.headline}`}
              title={fit.headline}
            >
              <VerdictDot verdict={fit.verdict} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <div className="flex flex-col gap-2">
              <p className={cn("text-sm", VERDICT_TEXT[fit.verdict])}>{fit.headline}</p>
              <FitDetails fit={fit} sprint={sprint} />
            </div>
          </PopoverContent>
        </Popover>
      )}
      {!fit && failed && <span className="ml-2 text-xs text-muted-foreground">{unread}</span>}
    </span>
  );
}

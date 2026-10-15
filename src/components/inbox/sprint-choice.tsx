/**
 * New tickets and the sprint (FR-16, D57): the switch that adds a create to the
 * user's active sprint, whether the sprint has room, and the details behind it.
 * The switch saves at once (`Proposals.saveEdit`) and marks the value chosen,
 * so revisions keep it; Approve stays one click.
 */
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import type { ProposalView } from "@/services/inbox/queries";
import type { PayloadOf } from "@/services/proposals/schema";
import type { Fit, Verdict } from "@/services/sprints/fit";
import type { CreateSprintFit } from "@/services/sprints/fit-query";
import { useDecisions } from "./use-inbox";
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
 * The create's switch state, saved at once and marked chosen (D57). The local
 * value covers the moment between the save and the refreshed proposal.
 */
export function useSprintSwitch(proposal: ProposalView) {
  const { saveEdit } = useDecisions();
  const payload = (proposal.editedPayload ?? proposal.payload) as PayloadOf<"create_issue">;
  const fits = useThreadSprintFits(proposal.inboxItemId, proposal.kind === "create_issue");
  // Shown until the saved proposal comes back with a different value.
  const [local, setLocal] = useState<{ value: boolean; over: boolean } | null>(null);
  const checked = local && local.over === payload.joinSprint ? local.value : payload.joinSprint;
  const set = (joinSprint: boolean) => {
    if (proposal.status !== "pending") return;
    setLocal({ value: joinSprint, over: payload.joinSprint });
    saveEdit.mutate(
      { id: proposal.id, edited: { ...payload, joinSprint, joinSprintChosen: true } },
      { onError: () => setLocal(null) },
    );
  };
  const choice: CreateSprintFit | undefined = fits.data?.[proposal.id];
  return { choice, checked, set, busy: saveEdit.isPending, payload };
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
  if (!sw.choice || sw.choice.kind === "never") return null;
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
  if (!choice || choice.kind === "never") return null;
  if (choice.kind === "no_sprint")
    return <span className="text-muted-foreground">No active sprint; it goes to the backlog</span>;
  const { sprint, fit, offBoard } = choice;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Switch
          id={id}
          size="sm"
          checked={checked}
          disabled={busy || proposal.status !== "pending"}
          onCheckedChange={set}
        />
        <Label htmlFor={id} className="font-normal">
          Add to {sprint.name}
        </Label>
        <span className="text-xs text-muted-foreground">{sprint.when}</span>
      </div>
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
 * the row, which saves its fields together.
 */
export function SprintChip({
  choice,
  checked,
  onChange,
  disabled,
}: {
  choice: CreateSprintFit | undefined;
  checked: boolean;
  onChange: (joinSprint: boolean) => void;
  disabled?: boolean;
}) {
  if (!choice || choice.kind === "never") return null;
  if (choice.kind === "no_sprint")
    return <span className="text-xs text-muted-foreground">No active sprint</span>;
  const { sprint, fit } = choice;
  return (
    <span className="inline-flex items-center">
      <Toggle
        size="sm"
        variant="outline"
        pressed={checked}
        disabled={disabled}
        onPressedChange={onChange}
        aria-label={`Add to ${sprint.name}`}
        title={`Add to ${sprint.name}, ${sprint.when}`}
        className="rounded-r-none"
      >
        Sprint
      </Toggle>
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
    </span>
  );
}

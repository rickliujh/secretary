/**
 * The ticket view's Edit dialog (FR-1.7, FR-17, D58): summary, priority, due
 * date, story points, the sprint, the epic, labels and the description. One
 * Save writes only what the user changed, in order, through the Executor;
 * when a write fails the dialog stays open and the toast says what was saved.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect, useRef } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { describeError } from "@/app/errors";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { VerdictLine } from "@/components/inbox/sprint-choice";
import {
  useKnownSprints,
  useLocalDate,
  useTicketSprintFit,
} from "@/components/inbox/use-sprint-fit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { onSelect } from "@/lib/select-change";
import { JiraClient } from "@/services/jira";
import { fitSprint, type SprintChoices, sprintChoices } from "@/services/sprints/options";
import {
  baselineAfterSave,
  changedValues,
  editOutcomeText,
  editProblems,
  editValues,
  parsePointsInput,
  type TicketEditValues,
  ticketEditSteps,
} from "@/services/tickets/edit";
import { epicsInProject, type TicketDetail } from "@/services/tickets/queries";
import { saveTicketEdit } from "@/services/tickets/save-edit";

type Issue = TicketDetail["issue"];

const NO_EPIC = "__none__";

const EditForm = z.object({
  summary: z.string().trim().min(1, "Summary is required"),
  priority: z.string(),
  dueDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  descriptionWiki: z.string(),
  /** Checked against the baseline on Save (`editProblems`), so an odd cached value never blocks it. */
  points: z.string(),
  labels: z.string(),
  epic: z.string(),
  /** Empty until the user picks one: the current sprint stays. */
  sprint: z.string(),
}) satisfies z.ZodType<TicketEditValues>;

/** The Sprint select's options for the ticket, from the synced sprints; none while they load. */
function useSprintChoices(issue: Issue, open: boolean): SprintChoices | null {
  const known = useKnownSprints(open);
  const today = useLocalDate();
  if (!known.data) return null;
  return sprintChoices({
    sprints: known.data.sprints,
    boardProjects: known.data.boardProjects,
    projectKey: issue.projectKey,
    issueType: issue.issueType,
    isSubtask: issue.isSubtask,
    current: issue.sprint,
    today,
  });
}

export function EditDialog({
  issue,
  open,
  onOpenChange,
}: {
  issue: Issue;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const priorities = useQuery({
    queryKey: queryKeys.priorities,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(JiraClient, (j) => j.priorities),
        signal,
      ),
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });
  const noEpic = issue.issueType === "Epic" || issue.isSubtask;
  const epics = useQuery({
    queryKey: queryKeys.epics(issue.projectKey),
    queryFn: ({ signal }) => run(epicsInProject(issue.projectKey), signal),
    enabled: open && !noEpic,
  });
  const choices = useSprintChoices(issue, open);
  // The sprint field stays empty until the user picks one, so the synced
  // sprints may arrive after the dialog opened.
  const currentSprint = choices?.kind === "pick" ? choices.value : "";
  const sprintNames = Object.fromEntries(
    choices?.kind === "pick" ? choices.options.map((o) => [o.value, o.name]) : [],
  );

  const initial = editValues(issue, "");
  const form = useForm<TicketEditValues>({
    resolver: zodResolver(EditForm),
    defaultValues: initial,
  });
  // What the dialog opened with, moved on by each Save, to tell the fields the
  // user changed (`changedValues`).
  const baseline = useRef(initial);
  // Reset only when the dialog opens or shows another ticket: after a partial
  // failure the refreshed ticket must not wipe what the user typed (D58).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open or another ticket.
  useEffect(() => {
    if (!open) return;
    baseline.current = initial;
    form.reset(initial);
  }, [open, issue.key]);

  const save = useAppMutation(saveTicketEdit, {
    invalidate: [queryKeys.tickets],
    invalidateOnError: true,
  });
  const onSubmit = form.handleSubmit((v) => {
    const problems = editProblems(baseline.current, v);
    for (const [name, message] of Object.entries(problems))
      form.setError(name as "points" | "labels", { message });
    if (Object.keys(problems).length) return;
    const now = editValues(issue, currentSprint);
    const values = changedValues(baseline.current, v, now);
    const steps = ticketEditSteps(issue, now, values, sprintNames);
    if (steps.length === 0) return onOpenChange(false);
    save.mutate(steps, {
      onSuccess: (outcome) => {
        // What was written counts from now on, even when a later step failed.
        baseline.current = baselineAfterSave(baseline.current, values, outcome.saved);
        if (!outcome.failed) {
          toast.success(editOutcomeText(issue.key, outcome).title, {
            description: outcome.refreshed
              ? undefined
              : "Saved in Jira; the local copy refreshes on the next sync.",
          });
          return onOpenChange(false);
        }
        const error = describeError(outcome.failed.error);
        const text = editOutcomeText(issue.key, outcome, error.description ?? error.title);
        toast.error(text.title, {
          description: text.description,
          action: { label: "Retry", onClick: () => void submitRef.current?.() },
        });
      },
    });
  });
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  const [pointsInput, sprintValue] = useWatch({
    control: form.control,
    name: ["points", "sprint"],
  });
  const pickedSprint = sprintValue || currentSprint;
  // The room line for an active sprint the ticket is not in (FR-17.3).
  const fitSprintId = open ? (fitSprint(choices, pickedSprint)?.id ?? null) : null;
  const typed = parsePointsInput(pointsInput);
  const fit = useTicketSprintFit(issue.key, issue.sprint, fitSprintId, {
    label: issue.summary,
    points: typed === undefined ? issue.storyPoints : typed,
    assignee: issue.assignee,
    assigneeName: issue.assigneeDisplay,
  });
  const shownFit = fitSprintId !== null && fit.data?.sprint.id === fitSprintId ? fit.data : null;

  const errors = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit}>
          <DialogHeader className="mb-4">
            <DialogTitle>Edit {issue.key}</DialogTitle>
            <DialogDescription>Only changed fields are sent to Jira.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.summary}>
              <FieldLabel htmlFor="edit-summary">Summary</FieldLabel>
              <Input id="edit-summary" {...form.register("summary")} />
              <FieldError errors={[errors.summary]} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Controller
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="edit-priority">Priority</FieldLabel>
                    <Select value={field.value} onValueChange={onSelect(field.onChange)}>
                      <SelectTrigger id="edit-priority" className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          priorities.data ??
                          (issue.priority ? [{ id: "current", name: issue.priority }] : [])
                        ).map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Field>
                <FieldLabel htmlFor="edit-due">Due date</FieldLabel>
                <Input id="edit-due" type="date" {...form.register("dueDate")} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!errors.points}>
                <FieldLabel htmlFor="edit-points">Story points</FieldLabel>
                {/* Text, not a number input, so a decimal comma reaches the parser. */}
                <Input
                  id="edit-points"
                  inputMode="decimal"
                  placeholder="None"
                  {...form.register("points")}
                />
                <FieldDescription>Empty clears them.</FieldDescription>
                <FieldError errors={[errors.points]} />
              </Field>
              <SprintField
                choices={choices}
                loading={open && !choices}
                value={pickedSprint}
                onChange={(v) => form.setValue("sprint", v, { shouldDirty: true })}
              />
            </div>
            {shownFit && <VerdictLine fit={shownFit.fit} sprint={shownFit.sprint} />}
            <div className="grid grid-cols-2 gap-4">
              {!noEpic && (
                <Controller
                  control={form.control}
                  name="epic"
                  render={({ field }) => (
                    <Field>
                      <FieldLabel htmlFor="edit-epic">Epic</FieldLabel>
                      <Select
                        value={field.value || NO_EPIC}
                        onValueChange={onSelect((v) => field.onChange(v === NO_EPIC ? "" : v))}
                      >
                        <SelectTrigger id="edit-epic" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_EPIC}>No epic</SelectItem>
                          {issue.epicKey && !epics.data?.some((e) => e.key === issue.epicKey) && (
                            <SelectItem value={issue.epicKey}>{issue.epicKey}</SelectItem>
                          )}
                          {(epics.data ?? []).map((e) => (
                            <SelectItem key={e.key} value={e.key}>
                              {e.key} {e.epicName || e.summary}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                />
              )}
              <Field data-invalid={!!errors.labels} className={noEpic ? "col-span-2" : undefined}>
                <FieldLabel htmlFor="edit-labels">Labels</FieldLabel>
                <Input id="edit-labels" placeholder="None" {...form.register("labels")} />
                <FieldDescription>Separated by spaces or commas.</FieldDescription>
                <FieldError errors={[errors.labels]} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="edit-description">Description</FieldLabel>
              <Textarea
                id="edit-description"
                rows={12}
                className="font-mono text-xs"
                {...form.register("descriptionWiki")}
              />
              <FieldDescription>
                Jira wiki markup, edited as stored so panels and tables are not lost.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving..." : "Save to Jira"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Sprint select (D58): Backlog and the open sprints with their dates. A
 * current sprint that cannot be picked again shows as the value, and a closed
 * one as a hint under Backlog; nothing for an Epic, and a sub-task says it
 * follows its parent.
 */
function SprintField({
  choices,
  loading,
  value,
  onChange,
}: {
  choices: SprintChoices | null;
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  if (choices?.kind === "none" && choices.reason === "epic") return null;
  return (
    <Field>
      <FieldLabel htmlFor="edit-sprint">Sprint</FieldLabel>
      {choices?.kind === "none" ? (
        <p className="text-sm text-muted-foreground">Follows its parent's sprint</p>
      ) : (
        <Select
          value={value}
          onValueChange={onSelect(onChange)}
          disabled={choices?.kind !== "pick"}
        >
          <SelectTrigger id="edit-sprint" className="w-full">
            <SelectValue placeholder={loading ? "Loading..." : "Backlog"} />
          </SelectTrigger>
          <SelectContent>
            {(choices?.kind === "pick" ? choices.options : []).map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={!o.pickable}>
                {o.name}
                {o.when && <span className="text-muted-foreground"> · {o.when}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {choices?.kind === "pick" && choices.hint && (
        <FieldDescription>{choices.hint}</FieldDescription>
      )}
    </Field>
  );
}

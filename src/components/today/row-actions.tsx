/**
 * Today's row actions (D49): Done, snooze, a draft, log a reply, resolve. Each
 * gives a toast with the result, is disabled while it runs, and refreshes the
 * lists; Jira writes go through the Executor (`services/dashboard/actions`).
 */
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, MessageSquare, MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { useDraftPanel } from "@/components/drafts/use-draft-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { addBusinessDays, localDate } from "@/lib/dates";
import { doneOptions, finishTicket } from "@/services/dashboard/actions";
import { type SnoozePreset, snoozeDay, validSnoozeDay } from "@/services/dashboard/closing";
import type { DashIssue } from "@/services/dashboard/sections";
import type { Transition } from "@/services/jira/schemas";
import { useRowAction } from "./use-today";

/** The calendar day after a YYYY-MM-DD day. */
const nextDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const weekdayOf = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/** An icon button with its name as a tooltip and an accessible label. */
export function IconAction({
  label,
  busy,
  disabled,
  onClick,
  children,
}: {
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={label}
          disabled={disabled || busy}
          onClick={onClick}
        >
          {busy ? <Loader2 className="animate-spin" /> : children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Loads the transitions that finish a ticket when asked: one runs at once,
 * several are offered as a choice, none is an error naming the ticket.
 */
export function useDone(issueKey: string, onFinished?: () => void) {
  const client = useQueryClient();
  const onError = useErrorToast();
  const [loading, setLoading] = useState(false);
  const [choices, setChoices] = useState<Transition[] | null>(null);
  const finish = useRowAction((t: Transition) => finishTicket(issueKey, t), {
    onSuccess: () => onFinished?.(),
  });
  const start = async () => {
    setLoading(true);
    try {
      const options = await client.fetchQuery({
        queryKey: queryKeys.doneTransitions(issueKey),
        queryFn: ({ signal }) => run(doneOptions(issueKey), signal),
        staleTime: 0,
      });
      const only = options.length === 1 ? options[0] : undefined;
      if (only) finish.mutate(only);
      else if (options.length > 1) setChoices(options);
      else
        toast.error(`${issueKey} has no transition to a done status from here`, {
          description: "Its workflow offers none now; move it from the ticket view.",
        });
    } catch (e) {
      onError(e, () => void start());
    } finally {
      setLoading(false);
    }
  };
  return {
    start,
    choices,
    clearChoices: () => setChoices(null),
    pick: (t: Transition) => {
      setChoices(null);
      finish.mutate(t);
    },
    busy: loading || finish.isPending,
  };
}

/** Done: the transition to a done status; a menu when the workflow has several. */
export function DoneButton({ issueKey }: { issueKey: string }) {
  const done = useDone(issueKey);
  return (
    <DropdownMenu
      open={!!done.choices}
      onOpenChange={(open) => {
        if (!open) done.clearChoices();
        else if (!done.busy) void done.start();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={`Done: ${issueKey}`}
              disabled={done.busy}
            >
              {done.busy ? <Loader2 className="animate-spin" /> : <Check />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Done</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Close {issueKey} as</DropdownMenuLabel>
        {done.choices?.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => done.pick(t)}>
            {t.name}
            {t.name !== t.to.name && <span className="text-muted-foreground">→ {t.to.name}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Snooze presets for a row's menu; "Pick a date" opens `SnoozeDateDialog`. A
 * day not after `after` (a wait's back day) is offered disabled: it would
 * change nothing.
 */
export function SnoozeItems({
  sprintEnd,
  onPick,
  onPickDate,
  label = "Snooze",
  after = null,
}: {
  sprintEnd: string | null;
  onPick: (day: string) => void;
  onPickDate: () => void;
  label?: string;
  after?: string | null;
}) {
  const today = localDate();
  const preset = (p: SnoozePreset) => {
    const day = snoozeDay(p, today, sprintEnd);
    return day && validSnoozeDay(day, today, after) ? day : null;
  };
  const why = (p: SnoozePreset) =>
    p === "sprint" && !snoozeDay(p, today, sprintEnd)
      ? "no active sprint"
      : after
        ? `back ${weekdayOf(after)}`
        : "";
  const items: [SnoozePreset, string][] = [
    ["tomorrow", "Tomorrow"],
    ["monday", "Monday"],
    ["sprint", "After the sprint"],
  ];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {items.map(([p, name]) => {
          const day = preset(p);
          return (
            <DropdownMenuItem key={p} disabled={!day} onSelect={() => day && onPick(day)}>
              {name}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                {day ? weekdayOf(day) : why(p)}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onPickDate}>Pick a date...</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A day after today (and after `after`, a wait's back day) to snooze to. */
export function SnoozeDateDialog({
  open,
  onOpenChange,
  title,
  onPick,
  after = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onPick: (day: string) => void;
  after?: string | null;
}) {
  const today = localDate();
  const floor = after && after > today ? after : today;
  const [picked, setDay] = useState<string | null>(null);
  const day = picked ?? (floor === today ? addBusinessDays(today, 1) : nextDay(floor));
  const valid = validSnoozeDay(day, today, after);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onPick(day);
            onOpenChange(false);
          }}
        >
          <DialogHeader className="mb-4">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>It comes back on Today on that day.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!valid}>
            <FieldLabel htmlFor="snooze-day">Until</FieldLabel>
            <Input
              id="snooze-day"
              type="date"
              min={nextDay(floor)}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
            {!valid && (
              <FieldDescription>
                {floor === today
                  ? "Pick a day after today."
                  : `Pick a day after ${weekdayOf(floor)}, when they are back: until then, being back brings it up anyway.`}
              </FieldDescription>
            )}
          </Field>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Snooze
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A reply draft about a ticket, to whoever asked when known (D50 panel). */
export function useReplyDraft() {
  const panel = useDraftPanel();
  return (issue: Pick<DashIssue, "key" | "requester">) =>
    panel.open({
      prefill: {
        issueKeys: [issue.key],
        intent: "status_update",
        ...(issue.requester
          ? { recipient: { type: "person" as const, id: issue.requester.id } }
          : {}),
      },
    });
}

export function ReplyButton({ issue }: { issue: Pick<DashIssue, "key" | "requester"> }) {
  const reply = useReplyDraft();
  return (
    <IconAction
      label={issue.requester ? `Reply to ${issue.requester.name}` : "Draft a reply"}
      onClick={() => reply(issue)}
    >
      <MessageSquare />
    </IconAction>
  );
}

/**
 * The "more" menu of a row. Not modal: its items open dialogs (pick a date,
 * log a reply), and a modal menu closing as a dialog opens can leave the page
 * with `pointer-events: none` (a Radix pitfall).
 */
export function MoreMenu({
  label,
  busy,
  children,
}: {
  label: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={label}
          disabled={busy}
        >
          {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

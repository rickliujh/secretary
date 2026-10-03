/**
 * The sweep (FR-12.3, D49): a dialog that steps through what needs a decision,
 * one item at a time, entirely from the keyboard. Nothing happens without a
 * key press (or a click on the same buttons); it ends with a summary.
 *
 * Keys: D done, N nudge, S snooze, X drop (asks why first), Space skip, Esc
 * leave. In the snooze and done choices, 1 to 9 pick; Esc goes back.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Loader2 } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppMutation, useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { useChaseDraft } from "@/components/drafts/use-drafts";
import { TicketLink } from "@/components/tickets/ticket-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { localDate } from "@/lib/dates";
import {
  doneOptions,
  dropTicket,
  dropWait,
  finishTicket,
  lastStalePass,
  markStalePass,
  resolveWait,
  snoozeTicket,
  snoozeWait,
} from "@/services/dashboard/actions";
import { SNOOZE_PRESETS, snoozeDay, validSnoozeDay } from "@/services/dashboard/closing";
import {
  SWEEP_WHY,
  type SweepItem,
  type SweepOutcome,
  stalePassDue,
  sweepItems,
  sweepSummary,
} from "@/services/dashboard/sweep";
import type { Today } from "@/services/dashboard/today";
import type { Transition } from "@/services/jira/schemas";
import { useReplyDraft } from "./row-actions";
import { useRowAction } from "./use-today";

type WaitItem = Extract<SweepItem, { why: "followup" | "back" }>;
type TicketItem = Exclude<SweepItem, WaitItem>;
const isWait = (i: SweepItem | undefined): i is WaitItem =>
  i?.why === "followup" || i?.why === "back";
const isTicket = (i: SweepItem | undefined): i is TicketItem => !!i && !isWait(i);

const SNOOZE_NAMES = { tomorrow: "Tomorrow", monday: "Monday", sprint: "After the sprint" };

const dayName = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/** The header button: how many items are due for a sweep, and the dialog. */
export function SweepButton({ today }: { today: Today }) {
  const staleAt = useQuery({
    queryKey: queryKeys.sweepStale,
    queryFn: ({ signal }) => run(lastStalePass, signal),
  });
  const stale = staleAt.isSuccess && stalePassDue(staleAt.data, new Date());
  const items = useMemo(() => sweepItems(today, localDate(), { stale }), [today, stale]);
  // The items are fixed when the sweep starts, so Today refreshing behind it
  // (rows leave as they are done) does not move the sweep.
  const [session, setSession] = useState<{ items: SweepItem[]; stale: boolean } | null>(null);
  return (
    <>
      <Button
        size="sm"
        disabled={staleAt.isPending}
        onClick={() => setSession({ items, stale })}
        aria-label={`Sweep: ${items.length} to decide`}
      >
        <ListChecks /> Sweep
        {items.length > 0 && (
          <Badge variant="secondary" className="tabular-nums">
            {items.length}
          </Badge>
        )}
      </Button>
      {session && (
        <SweepDialog
          items={session.items}
          stale={session.stale}
          sprintEnd={today.sprintEnd}
          onClose={() => setSession(null)}
        />
      )}
    </>
  );
}

type Mode = "idle" | "done" | "snooze" | "drop";

function SweepDialog({
  items,
  stale,
  sprintEnd,
  onClose,
}: {
  items: SweepItem[];
  stale: boolean;
  sprintEnd: string | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const onError = useErrorToast();
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<SweepOutcome[]>([]);
  const [mode, setMode] = useState<Mode>("idle");
  const [choices, setChoices] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const item = items[index];
  const finished = index >= items.length;
  const today = localDate();

  const advance = (outcome: SweepOutcome) => {
    setOutcomes((o) => [...o, outcome]);
    setIndex((i) => i + 1);
    setMode("idle");
    setReason("");
    setDay("");
  };

  // Keys go to the dialog body; put focus back there after each step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the step or mode changes.
  useEffect(() => {
    if (mode === "idle") body.current?.focus();
  }, [index, mode]);

  // The weekly pass over untouched asks counts as run once a sweep that held it ends.
  const markStale = useAppMutation(() => markStalePass(), {
    invalidate: [queryKeys.sweepStale],
    toastError: false,
  });
  const marked = useRef(false);
  useEffect(() => {
    if (finished && stale && !marked.current) {
      marked.current = true;
      markStale.mutate();
    }
  }, [finished, stale, markStale]);

  const ticketDone = useRowAction((i: { key: string; t: Transition }) => finishTicket(i.key, i.t), {
    onSuccess: () => advance("done"),
  });
  const ticketSnooze = useRowAction(
    (i: { key: string; day: string }) => snoozeTicket(i.key, i.day),
    { onSuccess: () => advance("snoozed") },
  );
  const ticketDrop = useRowAction(
    (i: { key: string; reason: string }) => dropTicket(i.key, i.reason),
    { onSuccess: () => advance("dropped") },
  );
  const waitResolve = useRowAction(
    (i: { id: string; label: string }) => resolveWait(i.id, i.label),
    { onSuccess: () => advance("done") },
  );
  const waitSnooze = useRowAction(
    (i: { id: string; label: string; day: string }) => snoozeWait(i.id, i.label, i.day),
    { onSuccess: () => advance("snoozed") },
  );
  const waitDrop = useRowAction(
    (i: { id: string; label: string; reason: string }) => dropWait(i.id, i.label, i.reason),
    { onSuccess: () => advance("dropped") },
  );
  const chase = useChaseDraft();
  const reply = useReplyDraft();
  const busy =
    loading ||
    chase.isPending ||
    [ticketDone, ticketSnooze, ticketDrop, waitResolve, waitSnooze, waitDrop].some(
      (m) => m.isPending,
    );

  const done = async () => {
    if (isWait(item)) {
      const d = item.row.dependency;
      return waitResolve.mutate({ id: d.id, label: d.label });
    }
    if (!isTicket(item)) return;
    const key = item.row.issue.key;
    setLoading(true);
    try {
      const options = await client.fetchQuery({
        queryKey: queryKeys.doneTransitions(key),
        queryFn: ({ signal }) => run(doneOptions(key), signal),
        staleTime: 0,
      });
      const only = options.length === 1 ? options[0] : undefined;
      if (only) ticketDone.mutate({ key, t: only });
      else if (options.length > 1) {
        setChoices(options);
        setMode("done");
      } else
        toast.error(`${key} has no transition to a done status from here`, {
          description: "Skip it and move it from the ticket view.",
        });
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  };

  const nudge = () => {
    if (isWait(item))
      return chase.mutate(item.row.dependency.id, { onSuccess: () => advance("nudged") });
    if (!isTicket(item)) return;
    reply(item.row.issue);
    advance("nudged");
  };

  const snooze = (until: string) => {
    if (!validSnoozeDay(until, today)) return;
    if (isWait(item)) {
      const d = item.row.dependency;
      return waitSnooze.mutate({ id: d.id, label: d.label, day: until });
    }
    if (isTicket(item)) ticketSnooze.mutate({ key: item.row.issue.key, day: until });
  };

  const drop = () => {
    if (!reason.trim()) return;
    if (isWait(item)) {
      const d = item.row.dependency;
      return waitDrop.mutate({ id: d.id, label: d.label, reason });
    }
    if (isTicket(item)) ticketDrop.mutate({ key: item.row.issue.key, reason });
  };

  const presets = SNOOZE_PRESETS.map((p) => ({ p, day: snoozeDay(p, today, sprintEnd) }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (busy || finished || e.ctrlKey || e.metaKey || e.altKey) return;
    // Typing a reason or a date is not a command.
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : null;
    if (mode === "done" && digit !== null) {
      const t = choices[digit];
      if (t && isTicket(item)) ticketDone.mutate({ key: item.row.issue.key, t });
    } else if (mode === "snooze" && digit !== null) {
      const d = presets[digit]?.day;
      if (d) snooze(d);
    } else if (mode === "idle") {
      const k = e.key.toLowerCase();
      if (k === "d") void done();
      else if (k === "n") nudge();
      else if (k === "s") setMode("snooze");
      else if (k === "x") setMode("drop");
      else if (e.key === " ") advance("skipped");
      else return;
    } else return;
    e.preventDefault();
  };

  const leave = () => {
    if (!finished && outcomes.length > 0) toast(sweepSummary(outcomes, items.length));
    onClose();
  };

  const onWait = isWait(item);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && leave()}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          // Start on the item, not on a button, so Space skips instead of pressing it.
          e.preventDefault();
          body.current?.focus();
        }}
        onEscapeKeyDown={(e) => {
          // Esc backs out of a choice first; with nothing open it leaves.
          if (busy || mode !== "idle") {
            e.preventDefault();
            if (!busy) setMode("idle");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{finished ? "Sweep done" : "Sweep"}</DialogTitle>
          <DialogDescription>
            {finished
              ? sweepSummary(outcomes, items.length)
              : `${index + 1} of ${items.length}${item ? ` · ${SWEEP_WHY[item.why]}` : ""}`}
          </DialogDescription>
        </DialogHeader>
        {items.length > 0 && (
          <Progress
            value={(Math.min(index, items.length) / items.length) * 100}
            aria-label={`${Math.min(index, items.length)} of ${items.length} decided`}
          />
        )}
        <div ref={body} tabIndex={-1} className="min-w-0 outline-none">
          {finished ? (
            <Summary items={items} outcomes={outcomes} />
          ) : item ? (
            <div className="flex flex-col gap-3">
              <ItemCard item={item} />
              {mode === "done" && (
                <Choices
                  label="Close as"
                  options={choices.map((t) => ({
                    key: t.id,
                    name: t.name === t.to.name ? t.name : `${t.name} → ${t.to.name}`,
                    onPick: () =>
                      isTicket(item) && ticketDone.mutate({ key: item.row.issue.key, t }),
                  }))}
                />
              )}
              {mode === "snooze" && (
                <div className="flex flex-col gap-2">
                  <Choices
                    label={onWait ? "Chase again" : "Snooze until"}
                    options={presets.map(({ p, day: d }) => ({
                      key: p,
                      name: `${SNOOZE_NAMES[p]}${d ? ` (${dayName(d)})` : ""}`,
                      disabled: !d,
                      onPick: () => d && snooze(d),
                    }))}
                  />
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      snooze(day);
                    }}
                  >
                    <Field className="flex-1">
                      <FieldLabel htmlFor="sweep-day">Or a day</FieldLabel>
                      <Input
                        id="sweep-day"
                        type="date"
                        value={day}
                        onChange={(e) => setDay(e.target.value)}
                      />
                    </Field>
                    <Button type="submit" size="sm" disabled={!validSnoozeDay(day, today)}>
                      Snooze
                    </Button>
                  </form>
                </div>
              )}
              {mode === "drop" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    drop();
                  }}
                >
                  <Field>
                    <FieldLabel htmlFor="sweep-reason">
                      {onWait ? "Why stop waiting?" : "Why drop it?"}
                    </FieldLabel>
                    <Textarea
                      id="sweep-reason"
                      rows={2}
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          drop();
                        }
                      }}
                    />
                    <FieldDescription>
                      {onWait
                        ? "Goes on the wait's timeline; the wait is resolved. Enter drops, Esc goes back."
                        : "Posted as a comment on the ticket, which is closed (cancelled where the workflow allows). Enter drops, Esc goes back."}
                    </FieldDescription>
                  </Field>
                  <Button
                    type="submit"
                    size="sm"
                    className="mt-2"
                    disabled={!reason.trim() || busy}
                  >
                    Drop
                  </Button>
                </form>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter className="flex-wrap gap-1 sm:justify-start">
          {finished ? (
            <Button size="sm" onClick={leave}>
              Close
            </Button>
          ) : (
            <>
              <KeyButton k="D" disabled={busy || mode !== "idle"} onClick={() => void done()}>
                {onWait ? "Resolved" : "Done"}
              </KeyButton>
              <KeyButton k="N" disabled={busy || mode !== "idle"} onClick={nudge}>
                {onWait ? "Chase" : "Nudge"}
              </KeyButton>
              <KeyButton k="S" disabled={busy || mode !== "idle"} onClick={() => setMode("snooze")}>
                {onWait ? "Later" : "Snooze"}
              </KeyButton>
              <KeyButton k="X" disabled={busy || mode !== "idle"} onClick={() => setMode("drop")}>
                Drop
              </KeyButton>
              <KeyButton
                k="Space"
                disabled={busy || mode !== "idle"}
                onClick={() => advance("skipped")}
              >
                Skip
              </KeyButton>
              <KeyButton
                k="Esc"
                disabled={busy}
                onClick={() => (mode === "idle" ? leave() : setMode("idle"))}
              >
                {mode === "idle" ? "Leave" : "Back"}
              </KeyButton>
              {busy && <Loader2 className="ml-1 size-4 animate-spin text-muted-foreground" />}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyButton({
  k,
  disabled,
  onClick,
  children,
}: {
  k: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      aria-keyshortcuts={k === "Space" ? "Space" : k === "Esc" ? "Escape" : k}
    >
      <Kbd>{k}</Kbd>
      {children}
    </Button>
  );
}

function Choices({
  label,
  options,
}: {
  label: string;
  options: { key: string; name: string; disabled?: boolean; onPick: () => void }[];
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">{label}</legend>
      {options.map((o, n) => (
        <Button
          key={o.key}
          variant="outline"
          size="sm"
          className="justify-start"
          disabled={o.disabled}
          onClick={o.onPick}
        >
          <Kbd>{n + 1}</Kbd>
          <span className="truncate">{o.name}</span>
        </Button>
      ))}
    </fieldset>
  );
}

function ItemCard({ item }: { item: SweepItem }) {
  if (isWait(item)) {
    const { dependency: d, reason } = item.row;
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
        <p className="font-medium break-words">
          {d.label}
          {d.externalRef && <span className="ml-1 font-mono text-xs">{d.externalRef}</span>}
        </p>
        <p className="text-sm text-muted-foreground">
          {d.ownerName} · {reason} ·{" "}
          <TicketLink ticketKey={d.issueKey} className="text-xs">
            {d.issueKey}
          </TicketLink>
        </p>
      </div>
    );
  }
  if (!isTicket(item)) return null;
  const { issue, reason } = item.row;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <p className="flex min-w-0 items-baseline gap-2">
        <TicketLink ticketKey={issue.key} className="shrink-0">
          {issue.key}
        </TicketLink>
        <span className="min-w-0 font-medium break-words">{issue.summary}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        {reason} · {issue.status}
      </p>
    </div>
  );
}

const OUTCOME_LABEL: Record<SweepOutcome, string> = {
  done: "done",
  nudged: "nudged",
  snoozed: "snoozed",
  dropped: "dropped",
  skipped: "skipped",
};

function Summary({ items, outcomes }: { items: SweepItem[]; outcomes: SweepOutcome[] }) {
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing needs a decision now.</p>;
  return (
    <ul className="flex max-h-72 flex-col overflow-y-auto">
      {items.map((it, n) => (
        <li key={it.id} className="flex min-w-0 items-center gap-2 border-b py-1 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-sm">
            {isWait(it)
              ? it.row.dependency.label
              : isTicket(it) && `${it.row.issue.key} ${it.row.issue.summary}`}
          </span>
          <Badge variant="outline">{OUTCOME_LABEL[outcomes[n] ?? "skipped"]}</Badge>
        </li>
      ))}
    </ul>
  );
}

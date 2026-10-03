/**
 * The sweep (FR-12.3, D49): a dialog that steps through what needs a decision,
 * one item at a time, entirely from the keyboard. Nothing happens without a
 * key press (or a click on the same buttons); it ends with a summary.
 *
 * Keys: D done, N nudge, S snooze, X drop (asks why first), Space skip, Esc
 * leave. In the snooze and done choices, 1 to 9 pick; Esc goes back. The keys
 * act only with focus on the item (not on a button or field), never on
 * auto-repeat, and one action runs at a time (`services/dashboard/sweep.ts`).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Loader2 } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
  beginAction,
  changeMode,
  releaseAction,
  SWEEP_WHY,
  type SweepItem,
  type SweepMode,
  type SweepOutcome,
  type SweepSession,
  settleAction,
  skipShown,
  stalePassDue,
  startSweep,
  submitsReason,
  sweepFinished,
  sweepItems,
  sweepKey,
  sweepOutcomes,
  sweepSummary,
} from "@/services/dashboard/sweep";
import { type Today, waitSnoozeAfter } from "@/services/dashboard/today";
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

/** The sweep's session in a ref, so a guard sees the last action even before React renders again. */
function useSweepSession(ids: readonly string[]) {
  const ref = useRef<SweepSession | null>(null);
  if (!ref.current) ref.current = startSweep(ids, Date.now());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const get = () => ref.current as SweepSession;
  const set = (next: SweepSession) => {
    if (next === ref.current) return;
    ref.current = next;
    rerender();
  };
  return { s: get(), get, set };
}

/** What an action ends with: a decision (the sweep moves on), another mode, or nothing (the item stays). */
type Step = { outcome: SweepOutcome } | { mode: SweepMode } | null;

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
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const { s, get, set } = useSweepSession(ids);
  const [choices, setChoices] = useState<Transition[]>([]);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState("");
  const body = useRef<HTMLElement>(null);
  const item = items[s.index];
  const finished = sweepFinished(s);
  const busy = s.busy !== null;
  const mode = s.mode;
  const outcomes = sweepOutcomes(s);
  const today = localDate();

  // A new item starts with an empty reason and day.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the item changes.
  useEffect(() => {
    setReason("");
    setDay("");
  }, [s.index]);

  // Keys go to the dialog body; put focus back there after each step (the
  // drop reason takes it instead).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the step or mode changes.
  useEffect(() => {
    if (mode !== "drop") body.current?.focus();
  }, [s.index, mode]);

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

  // The sweep toasts errors itself, with a Retry for the same item.
  const quiet = { toastError: false };
  const ticketDone = useRowAction(
    (i: { key: string; t: Transition }) => finishTicket(i.key, i.t),
    quiet,
  );
  const ticketSnooze = useRowAction(
    (i: { key: string; day: string }) => snoozeTicket(i.key, i.day),
    quiet,
  );
  const ticketDrop = useRowAction(
    (i: { key: string; reason: string }) => dropTicket(i.key, i.reason),
    quiet,
  );
  const waitResolve = useRowAction(
    (i: { id: string; label: string }) => resolveWait(i.id, i.label),
    quiet,
  );
  const waitSnooze = useRowAction(
    (i: { id: string; label: string; day: string }) => snoozeWait(i.id, i.label, i.day),
    quiet,
  );
  const waitDrop = useRowAction(
    (i: { id: string; label: string; reason: string }) => dropWait(i.id, i.label, i.reason),
    quiet,
  );
  const chase = useChaseDraft();
  const reply = useReplyDraft();

  /**
   * The one guard every action goes through: it starts only when `canAct`
   * allows (nothing running, the item settled), and its result is recorded
   * for the item it ran on, whatever is shown by then.
   */
  const act = async (it: SweepItem, work: () => Promise<Step>, toastFailure = true) => {
    const begun = beginAction(get(), it.id, Date.now());
    if (!begun) return;
    set(begun);
    try {
      const step = await work();
      if (step && "outcome" in step) set(settleAction(get(), it.id, step.outcome, Date.now()));
      else set(releaseAction(get(), it.id, step?.mode));
    } catch (e) {
      set(releaseAction(get(), it.id));
      if (toastFailure) onError(e, () => void act(it, work, toastFailure));
    }
  };

  const done = (it: SweepItem | undefined) => {
    if (isWait(it)) {
      const d = it.row.dependency;
      return act(it, async () => {
        await waitResolve.mutateAsync({ id: d.id, label: d.label });
        return { outcome: "done" };
      });
    }
    if (!isTicket(it)) return;
    const key = it.row.issue.key;
    return act(it, async () => {
      const options = await client.fetchQuery({
        queryKey: queryKeys.doneTransitions(key),
        queryFn: ({ signal }) => run(doneOptions(key), signal),
        staleTime: 0,
      });
      const only = options.length === 1 ? options[0] : undefined;
      if (only) {
        await ticketDone.mutateAsync({ key, t: only });
        return { outcome: "done" };
      }
      if (options.length > 1) {
        setChoices(options);
        return { mode: "done" };
      }
      toast.error(`${key} has no transition to a done status from here`, {
        description: "Skip it and move it from the ticket view.",
      });
      return null;
    });
  };

  const pickDone = (it: SweepItem | undefined, t: Transition | undefined) => {
    if (!isTicket(it) || !t) return;
    return act(it, async () => {
      await ticketDone.mutateAsync({ key: it.row.issue.key, t });
      return { outcome: "done" };
    });
  };

  const nudge = (it: SweepItem | undefined) => {
    if (isWait(it))
      // The chase draft toasts its own errors.
      return act(
        it,
        async () => {
          await chase.mutateAsync(it.row.dependency.id);
          return { outcome: "nudged" };
        },
        false,
      );
    if (!isTicket(it)) return;
    return act(it, async () => {
      reply(it.row.issue);
      return { outcome: "nudged" };
    });
  };

  /** A wait's chase must also be after its owner's back day (D47); earlier changes nothing. */
  const snoozeAfter = isWait(item) ? waitSnoozeAfter(item.row.timing) : null;
  const snooze = (it: SweepItem | undefined, until: string) => {
    if (!it) return;
    if (!validSnoozeDay(until, today, isWait(it) ? waitSnoozeAfter(it.row.timing) : null)) return;
    if (isWait(it)) {
      const d = it.row.dependency;
      return act(it, async () => {
        await waitSnooze.mutateAsync({ id: d.id, label: d.label, day: until });
        return { outcome: "snoozed" };
      });
    }
    if (isTicket(it))
      return act(it, async () => {
        await ticketSnooze.mutateAsync({ key: it.row.issue.key, day: until });
        return { outcome: "snoozed" };
      });
  };

  const drop = (it: SweepItem | undefined) => {
    const why = reason.trim();
    if (!why || !it) return;
    if (isWait(it)) {
      const d = it.row.dependency;
      return act(it, async () => {
        await waitDrop.mutateAsync({ id: d.id, label: d.label, reason: why });
        return { outcome: "dropped" };
      });
    }
    if (isTicket(it))
      return act(it, async () => {
        await ticketDrop.mutateAsync({ key: it.row.issue.key, reason: why });
        return { outcome: "dropped" };
      });
  };

  const presets = SNOOZE_PRESETS.map((p) => {
    const d = snoozeDay(p, today, sprintEnd);
    return { p, day: d && validSnoozeDay(d, today, snoozeAfter) ? d : null, raw: d };
  });

  const skip = () => set(skipShown(get(), Date.now()));
  const toMode = (m: SweepMode) => set(changeMode(get(), m, Date.now()));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (finished) return;
    // Only on the sweep's own body (or the dialog itself): a focused button,
    // link or field keeps Space, Enter and typing.
    const onBody = e.target === body.current || e.target === e.currentTarget;
    const cmd = sweepKey(e, mode, onBody);
    if (!cmd) return;
    e.preventDefault();
    if (cmd.do === "pick") {
      if (mode === "done") void pickDone(item, choices[cmd.n]);
      else {
        const d = presets[cmd.n]?.day;
        if (d) void snooze(item, d);
      }
    } else if (cmd.do === "done") void done(item);
    else if (cmd.do === "nudge") void nudge(item);
    else if (cmd.do === "snooze") toMode("snooze");
    else if (cmd.do === "drop") toMode("drop");
    else skip();
  };

  const leave = () => {
    if (!finished && outcomes.length > 0) toast(sweepSummary(outcomes, items.length));
    onClose();
  };

  const onWait = isWait(item);
  const acting = busy || mode !== "idle";

  return (
    <Dialog open onOpenChange={(o) => !o && !get().busy && leave()}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          // Start on the item, not on a button, so the keys work at once.
          e.preventDefault();
          body.current?.focus();
        }}
        onEscapeKeyDown={(e) => {
          // A held Esc does not back out and then leave. Esc backs out of a
          // choice first; with nothing open it leaves.
          if (e.repeat || get().busy || get().mode !== "idle") {
            e.preventDefault();
            if (!e.repeat) toMode("idle");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{finished ? "Sweep done" : "Sweep"}</DialogTitle>
          <DialogDescription>
            {finished
              ? sweepSummary(outcomes, items.length)
              : `${s.index + 1} of ${items.length}${item ? ` · ${SWEEP_WHY[item.why]}` : ""}`}
          </DialogDescription>
        </DialogHeader>
        {items.length > 0 && (
          <Progress
            value={(Math.min(s.index, items.length) / items.length) * 100}
            aria-label={`${Math.min(s.index, items.length)} of ${items.length} decided`}
          />
        )}
        <section
          ref={body}
          tabIndex={-1}
          aria-label="Item to decide"
          aria-keyshortcuts="D N S X Space"
          className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {finished ? (
            <Summary items={items} outcomes={s.outcomes} />
          ) : item ? (
            <div className="flex flex-col gap-3">
              <ItemCard item={item} />
              {mode === "done" && (
                <Choices
                  label="Close as"
                  disabled={busy}
                  options={choices.map((t) => ({
                    key: t.id,
                    name: t.name === t.to.name ? t.name : `${t.name} → ${t.to.name}`,
                    onPick: () => void pickDone(item, t),
                  }))}
                />
              )}
              {mode === "snooze" && (
                <div className="flex flex-col gap-2">
                  <Choices
                    label={onWait ? "Chase again" : "Snooze until"}
                    disabled={busy}
                    options={presets.map(({ p, day: d, raw }) => ({
                      key: p,
                      name: `${SNOOZE_NAMES[p]}${raw ? ` (${dayName(raw)})` : ""}`,
                      disabled: !d,
                      onPick: () => d && void snooze(item, d),
                    }))}
                  />
                  {snoozeAfter && (
                    <p className="text-xs text-muted-foreground">
                      Only days after {dayName(snoozeAfter)}: until then, the owner being back
                      brings it up anyway.
                    </p>
                  )}
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void snooze(item, day);
                    }}
                  >
                    <Field className="flex-1">
                      <FieldLabel htmlFor="sweep-day">Or a day</FieldLabel>
                      <Input
                        id="sweep-day"
                        type="date"
                        value={day}
                        disabled={busy}
                        onChange={(e) => setDay(e.target.value)}
                      />
                    </Field>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busy || !validSnoozeDay(day, today, snoozeAfter)}
                    >
                      {onWait ? "Chase then" : "Snooze"}
                    </Button>
                  </form>
                </div>
              )}
              {mode === "drop" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void drop(item);
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
                      readOnly={busy}
                      onChange={(e) => setReason(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || e.shiftKey) return;
                        // Enter never types a new line here; a held one drops once at most.
                        e.preventDefault();
                        if (submitsReason({ ...e, isComposing: e.nativeEvent.isComposing }))
                          void drop(item);
                      }}
                    />
                    <FieldDescription>
                      {onWait
                        ? "Goes on the wait's timeline; the wait is resolved. Enter drops, Esc goes back."
                        : "Posted as a comment on the ticket, which is then closed (cancelled where the workflow allows). Enter drops, Esc goes back."}
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
        </section>
        <DialogFooter className="flex-wrap gap-1 sm:justify-start">
          {finished ? (
            <Button size="sm" onClick={leave}>
              Close
            </Button>
          ) : (
            <>
              <KeyButton k="D" disabled={acting} onClick={() => void done(item)}>
                {onWait ? "Resolved" : "Done"}
              </KeyButton>
              <KeyButton k="N" disabled={acting} onClick={() => void nudge(item)}>
                {onWait ? "Chase" : "Nudge"}
              </KeyButton>
              <KeyButton k="S" disabled={acting} onClick={() => toMode("snooze")}>
                {onWait ? "Later" : "Snooze"}
              </KeyButton>
              <KeyButton k="X" disabled={acting} onClick={() => toMode("drop")}>
                Drop
              </KeyButton>
              <KeyButton k="Space" disabled={acting} onClick={skip}>
                Skip
              </KeyButton>
              <KeyButton
                k="Esc"
                disabled={busy}
                onClick={() => (mode === "idle" ? leave() : toMode("idle"))}
              >
                {mode === "idle" ? "Leave" : "Back"}
              </KeyButton>
              {busy && (
                <Loader2
                  className="ml-1 size-4 animate-spin text-muted-foreground"
                  aria-label="Working"
                />
              )}
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
  disabled,
}: {
  label: string;
  options: { key: string; name: string; disabled?: boolean; onPick: () => void }[];
  /** Every option, while an action runs. */
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1" disabled={disabled}>
      <legend className="mb-1 text-xs text-muted-foreground">{label}</legend>
      {options.map((o, n) => (
        <Button
          key={o.key}
          variant="outline"
          size="sm"
          className="min-w-0 justify-start"
          disabled={disabled || o.disabled}
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

function Summary({
  items,
  outcomes,
}: {
  items: SweepItem[];
  outcomes: Readonly<Record<string, SweepOutcome>>;
}) {
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing needs a decision now.</p>;
  return (
    <ul className="flex max-h-72 flex-col overflow-y-auto">
      {items.map((it) => (
        <li key={it.id} className="flex min-w-0 items-center gap-2 border-b py-1 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-sm">
            {isWait(it)
              ? it.row.dependency.label
              : isTicket(it) && `${it.row.issue.key} ${it.row.issue.summary}`}
          </span>
          <Badge variant="outline">{OUTCOME_LABEL[outcomes[it.id] ?? "skipped"]}</Badge>
        </li>
      ))}
    </ul>
  );
}

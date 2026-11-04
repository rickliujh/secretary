import { Link } from "@tanstack/react-router";
import { AlertCircle, Check, Plus, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useSettings } from "@/app/hooks";
import { runStore, useNow } from "@/app/intake-runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { clock, isActive, type Run, type StepView, viewOf } from "@/services/intake/runs";
import { type CardAction, type Notice, runCardContent } from "./run-card-content";

const PILL: Record<string, string> = {
  run: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  ok: "bg-green-600/10 text-green-700 dark:text-green-400",
  bad: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

const NOTICE: Record<Notice["tone"], string> = {
  warn: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
  bad: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  ok: "bg-green-600/10 text-green-700 dark:text-green-400",
};

function StepDot({ status }: { status: StepView["status"] }) {
  if (status === "now") return <Spinner className="size-3.5 text-blue-600" />;
  return (
    <span
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-full border text-[9px] text-white",
        status === "done" && "border-green-600 bg-green-600",
        status === "bad" && "border-destructive bg-destructive",
        (status === "pending" || status === "stopped") && "border-border",
      )}
    >
      {status === "done" ? <Check className="size-2.5" /> : status === "bad" ? "!" : null}
    </span>
  );
}

/** The state pill: the run's state, with a spinner while it runs. */
export function RunPill({ run, className }: { run: Run; className?: string }) {
  const content = runCardContent(run, viewOf(run, Date.now()));
  return (
    <Badge className={cn("gap-1 border-0", PILL[content.pill.tone], className)}>
      {content.pill.spin && <Spinner className="size-3" />}
      {content.pill.label}
    </Badge>
  );
}

/**
 * The run under the message it reads (FR-21, D68): a plain spinner for the
 * first seconds, then the card of the mockup: the steps with their times, the
 * cards each item wrote (`children`, the existing proposal cards), the slow and
 * retry notices, the failure and stop actions, and a box for a correction sent
 * when the run ends.
 */
export function RunCard({
  run,
  children,
  onEdit,
  unread,
}: {
  run: Run;
  /** The cards the run wrote so far: the turn's answer. */
  children?: ReactNode;
  /** Edit: stop, take the message back, text back in the box. */
  onEdit: () => void;
  /** On the thread's newest card: items an earlier turn left unread, and its message. */
  unread?: { count: number; messageId: string | null } | null;
}) {
  const now = useNow(isActive(run));
  const view = viewOf(run, now);
  const settings = useSettings();
  const c = runCardContent(run, view, {
    // Until settings load, the buttons show as before.
    ...(settings.data ? { fastTier: !!settings.data.tiers.fast } : {}),
    ...(unread?.count ? { unread: unread.count } : {}),
  });
  const [note, setNote] = useState("");
  const thread = run.inboxItemId;
  const act = (action: CardAction) => {
    if (action === "retry-now") runStore.retryNow(run.id);
    else if (action === "fast-now") runStore.retryNow(run.id, "fast");
    else if ((action === "retry" || action === "resume") && thread)
      runStore.resume(thread, { messageId: run.messageId });
    else if (action === "fast" && thread)
      runStore.resume(thread, { tier: "fast", messageId: run.messageId });
    else if (action === "resume-unread" && thread)
      runStore.resume(thread, { messageId: unread?.messageId ?? null });
    else if (action === "edit") onEdit();
  };
  const stop = (
    <Button
      size="sm"
      variant="ghost"
      className="h-7"
      disabled={run.state === "stopping"}
      onClick={() => runStore.stop(run.id)}
    >
      <Square /> Stop
    </Button>
  );

  if (c.spinnerOnly)
    return (
      <div className="flex max-w-[95%] flex-col gap-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Spinner className="size-3.5" />
          Reading… <span className="font-mono text-xs">{clock(view.elapsedMs)}</span>
          {stop}
        </p>
        {children}
      </div>
    );

  return (
    <section
      aria-label="The run"
      className="flex max-w-[95%] flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{c.title}</span>
        <Badge className={cn("gap-1 border-0", PILL[c.pill.tone])}>
          {c.pill.spin && <Spinner className="size-3" />}
          {c.pill.label}
        </Badge>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{c.meta}</span>
        {c.running && stop}
      </div>
      {c.steps.length > 0 && (
        <ul className="grid gap-1.5 text-[13px]">
          {c.steps.map((s) => (
            <li
              key={s.key}
              className={cn(
                "flex items-center gap-2",
                s.status === "pending" || s.status === "stopped"
                  ? "text-muted-foreground"
                  : "text-foreground",
                s.status === "now" && "font-medium",
              )}
            >
              <StepDot status={s.status} />
              <span>{s.title}</span>
              {s.sub && (
                <span className="truncate text-xs font-normal text-muted-foreground">{s.sub}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {c.notices.map((n) => (
        <div
          key={n.tone + n.text}
          className={cn("flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2", NOTICE[n.tone])}
        >
          {n.tone === "bad" && <AlertCircle className="size-4 shrink-0" />}
          <span className="min-w-48 flex-1">
            {n.lead && <b>{n.lead} </b>}
            {n.text}
          </span>
          {n.actions.map((a) =>
            a.action === "settings" ? (
              <Link
                key={a.action}
                to="/settings"
                search={{ tab: "models" }}
                className="text-xs underline"
              >
                {a.label}
              </Link>
            ) : (
              <Button
                key={a.action}
                size="sm"
                variant={a.primary ? "default" : "outline"}
                className="h-7"
                onClick={() => act(a.action)}
              >
                {a.label}
              </Button>
            ),
          )}
        </div>
      ))}
      {children}
      {c.placeholder && (
        <div className="flex items-center gap-2 rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          {c.placeholder}
          <Skeleton className="h-2.5 flex-1" />
        </div>
      )}
      {c.running && (
        <>
          {run.corrections.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Sent when this run ends: {run.corrections.map((x) => `“${x}”`).join(", ")}
            </p>
          )}
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              runStore.addCorrection(run.id, note);
              setNote("");
            }}
          >
            <Input
              className="h-8 text-[13px]"
              value={note}
              aria-label="Add something while it runs"
              placeholder="Add something while it runs: “assign the task to me”. Applied as soon as the run ends."
              onChange={(e) => setNote(e.target.value)}
            />
            <Button size="sm" variant="outline" className="h-8" disabled={!note.trim()}>
              <Plus /> Add
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

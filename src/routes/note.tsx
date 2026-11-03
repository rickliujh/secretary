import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { BookOpenCheck, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { toastError } from "@/app/errors";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { useNoteEditor } from "@/components/note/use-note";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isRealDate, localDate } from "@/lib/dates";
import { relativeTime, shortDate } from "@/lib/time";
import { DailyNote, type SyncStatus } from "@/services/note";
import { dayBefore } from "@/services/note/queries";
import { describeRead } from "@/services/note/read";

export const Route = createFileRoute("/note")({
  validateSearch: z.object({ date: z.string().optional() }),
  component: NotePage,
});

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** The day after a YYYY-MM-DD date. */
const dayAfter = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
};

function syncLine(vaultName: string | null, status: SyncStatus | null): string {
  if (!vaultName) return "Not synced";
  if (!status) return `Syncing with ${vaultName}...`;
  if (status.state === "error") return `Not synced with ${vaultName}: ${status.message}`;
  if (status.state === "off") return "Not synced";
  if (status.state === "not_running") return `${vaultName}: Obsidian is not running`;
  return `In sync with ${vaultName} · ${relativeTime(status.at)}`;
}

/**
 * The daily note (FR-20, D65): one free-form note per local day, saved as the
 * user types. Earlier days are read-only. With a vault chosen in Settings >
 * Secretary, the vault's own daily note is the file of record. The secretary
 * reads what is new at each work pass, a minute after typing stops, and on
 * Read now; the line under the note says what the last reading did.
 */
function NotePage() {
  const { date: asked } = Route.useSearch();
  const navigate = useNavigate({ from: "/note" });
  const today = localDate();
  const date = asked && isRealDate(asked) && asked < today ? asked : today;
  const editable = date === today;
  const { data: settings } = useSettings();
  const cfg = settings?.secretary.dailyNote;
  const vault = settings?.dataSources.find((d) => d.id === cfg?.vaultSourceId && d.enabled) ?? null;
  // A page left open past midnight moves to the new day (on focus or the next poll).
  const [, setDay] = useState(today);
  const editor = useNoteEditor(date, editable, !!vault, () => setDay(localDate()));
  const lastRead = useQuery({
    queryKey: queryKeys.noteLastRead,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(DailyNote, (n) => n.lastRead),
        signal,
      ),
  });
  const read = useMutation({
    mutationFn: () => editor.readNow(),
    onError: (e) => toastError(e),
  });
  const go = (d: string) => void navigate({ search: { date: d === today ? undefined : d } });

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-3">
      <PageHeader
        title="Note"
        description="Your daily note: write anything. The secretary reads what is new and turns what needs doing into cards in the Inbox."
        actions={
          editable && cfg?.enabled ? (
            <Button variant="outline" disabled={read.isPending} onClick={() => read.mutate()}>
              {read.isPending ? <Loader2 className="animate-spin" /> : <BookOpenCheck />}
              Read now
            </Button>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Day before"
          onClick={() => go(dayBefore(date))}
        >
          <ChevronLeft />
        </Button>
        <span className="font-medium tabular-nums">
          {editable ? `Today · ${shortDate(date)}` : shortDate(date)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Day after"
          disabled={editable}
          onClick={() => go(dayAfter(date))}
        >
          <ChevronRight />
        </Button>
        {!editable && (
          <Button variant="link" size="sm" onClick={() => go(today)}>
            Back to today
          </Button>
        )}
        {editable && (
          <span className="ml-auto text-muted-foreground">
            {syncLine(vault?.name ?? null, editor.status)}
          </span>
        )}
      </div>
      {editable && editor.conflict && (
        <Alert>
          <AlertDescription className="flex items-start gap-2">
            <span className="flex-1">
              Your page and Obsidian changed the same lines since the last sync. Both versions are
              kept, Obsidian's first; tidy them up when you like.
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss"
              onClick={editor.dismissConflict}
            >
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {editor.text === null ? (
        <Loader2 className="m-6 animate-spin text-muted-foreground" aria-label="Loading the note" />
      ) : (
        <Textarea
          aria-label={`Note for ${date}`}
          className="min-h-[50vh] flex-1 font-mono"
          value={editor.text}
          readOnly={!editable}
          placeholder={
            editable
              ? "Write anything: what happened, what you promised, what you are waiting on. A line under a heading named Private is never read by a model."
              : "Nothing was written that day."
          }
          onChange={(e) => editor.onChange(e.target.value)}
        />
      )}
      {editable && (
        <p className="text-sm text-muted-foreground">
          {!cfg?.enabled ? (
            <>
              Reading is off.{" "}
              <Link to="/settings" search={{ tab: "secretary" }} className="underline">
                Turn it on in Settings
              </Link>
              .
            </>
          ) : lastRead.data ? (
            describeRead(lastRead.data, time)
          ) : (
            "Not read yet. The secretary reads new lines a minute after you stop typing."
          )}
        </p>
      )}
    </div>
  );
}

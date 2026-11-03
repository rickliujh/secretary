import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { BookOpenCheck, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { toastError } from "@/app/errors";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { BlockCardLayer } from "@/components/note/block-card";
import { type NoteCardsData, threadOf } from "@/components/note/block-marks";
import { NoteCardStore } from "@/components/note/card-store";
import { NoteEditor } from "@/components/note/note-editor";
import { useNoteEditor } from "@/components/note/use-note";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isRealDate, localDate } from "@/lib/dates";
import { relativeTime, shortDate } from "@/lib/time";
import { DailyNote, type SyncStatus } from "@/services/note";
import { blocksOf, threadSummaries } from "@/services/note/cards";
import { dayBefore } from "@/services/note/queries";
import { describeRead } from "@/services/note/read";
import { pickNoteVault } from "@/services/note/sync";

export const Route = createFileRoute("/note")({
  validateSearch: z.object({
    date: z.string().optional(),
    /** A conversation of the note: its block's card is pinned and scrolled to (D67). */
    thread: z.string().optional(),
  }),
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
 * Read now; the line under the note says what the last reading did. Each
 * block carries a small mark in the margin, and hovering it opens its card
 * beside the line (D67); the hover and the pin live in the card store and the
 * card's own component, never in this page's render. Showing the page makes
 * no model call; only Ask, Read this now and the readings do.
 */
function NotePage() {
  const { date: asked, thread: openThread } = Route.useSearch();
  const navigate = useNavigate({ from: "/note" });
  const today = localDate();
  const date = asked && isRealDate(asked) && asked < today ? asked : today;
  const editable = date === today;
  const { data: settings } = useSettings();
  const cfg = settings?.secretary.dailyNote;
  const vault = settings ? pickNoteVault(settings) : null;
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

  // What the reading did with the day's blocks, and what their threads hold (D67).
  const blocks = useQuery({
    queryKey: queryKeys.noteBlocks(date),
    queryFn: ({ signal }) => run(blocksOf(date), signal),
  });
  const threadIds = useMemo(
    () => [...new Set((blocks.data ?? []).map(threadOf).filter((id): id is string => !!id))].sort(),
    [blocks.data],
  );
  const threads = useQuery({
    queryKey: queryKeys.noteThreads(threadIds),
    queryFn: ({ signal }) => run(threadSummaries(threadIds), signal),
    enabled: threadIds.length > 0,
    // A new thread on the page keeps the other marks while the summaries load.
    placeholderData: (previous) => previous,
  });
  const privateHeading = cfg?.privateHeading ?? "Private";
  const byThread = useMemo(
    () => new Map((threads.data ?? []).map((t) => [t.id, t])),
    [threads.data],
  );
  const reads = editable && !!cfg?.enabled;
  const cards = useMemo<NoteCardsData>(
    () => ({
      privateHeading,
      rows: new Map((blocks.data ?? []).map((b) => [b.hash, b])),
      threads: byThread,
      reads,
    }),
    [privateHeading, blocks.data, byThread, reads],
  );
  // The hover cards: the block under the pointer, the open card, its anchor (D67).
  const [store] = useState(() => new NoteCardStore());
  const flushRef = useRef(editor.flush);
  flushRef.current = editor.flush;
  const flush = useCallback(() => flushRef.current(), []);
  const readMutate = read.mutate;
  const readNow = useCallback(() => readMutate(), [readMutate]);
  usePinThread(
    store,
    openThread,
    blocks.isSuccess && editor.text !== null,
    () => void navigate({ search: (prev) => ({ ...prev, thread: undefined }), replace: true }),
  );

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-3">
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
        <NoteEditor
          key={date}
          label={`Note for ${date}`}
          className="w-full max-w-[44rem] flex-1"
          value={editor.text}
          readOnly={!editable}
          placeholder={
            editable
              ? "Write anything: what happened, what you promised, what you are waiting on. A line under a heading named Private is never read by a model."
              : "Nothing was written that day."
          }
          onChange={editor.onChange}
          cards={cards}
          store={store}
          overlay={
            <BlockCardLayer
              store={store}
              date={date}
              editable={editable}
              reads={reads}
              threads={byThread}
              flush={flush}
              onReadNow={readNow}
              reading={read.isPending}
            />
          }
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

/**
 * `/note?thread=<id>` (the Inbox's "Note · <date>" badge): pins the card of
 * that thread's block and scrolls to it once the editor has its marks, then
 * `done` drops the parameter, so closing the card is not undone. When the
 * day's blocks are loaded (`ready`) and no block shows the thread within a
 * moment (its line was edited away), the parameter is dropped too, so a mark
 * appearing later does not pin out of the blue. The store may call its
 * listeners inside an editor update, so the pin runs after it.
 */
function usePinThread(
  store: NoteCardStore,
  thread: string | undefined,
  ready: boolean,
  done: () => void,
) {
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(() => {
    if (!thread) return;
    let over = false;
    let queued = false;
    const finish = () => {
      over = true;
      unsubscribe();
      clearTimeout(giveUp);
      doneRef.current();
    };
    const tryPin = () => {
      if (over || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!over && store.pinThread(thread)) finish();
      });
    };
    const unsubscribe = store.subscribe(tryPin);
    const giveUp = ready ? setTimeout(() => !over && finish(), PIN_GIVE_UP_MS) : undefined;
    tryPin();
    return () => {
      over = true;
      unsubscribe();
      clearTimeout(giveUp);
    };
  }, [store, thread, ready]);
}

/** How long a `?thread=` waits for its block once the day's blocks are loaded. */
const PIN_GIVE_UP_MS = 2000;

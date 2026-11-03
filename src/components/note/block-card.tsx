/**
 * The card of a block of the note (FR-20.7, D67): one Radix popover anchored
 * to the hovered or pinned block's first line, to its right on wide windows
 * and below the block on narrow ones, like an inline comment. Its content by
 * the block's state (`card-content.ts`): the thread's waiting cards as compact
 * rows (Approve, Edit, Reject; Approve all), a question's choices, what was
 * done with Undo, a reply box that continues the same thread, Ask for a block
 * without a conversation, Read this now, Try again, and Open in Inbox.
 * Decisions, replies, revokes and edits are the Inbox's own code; nothing here
 * calls Jira or a model directly. Its own component on the page, subscribed
 * to the card store, so a hover or a pin never re-renders the page.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Effect } from "effect";
import {
  BookOpenCheck,
  Check,
  CheckCheck,
  Inbox,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toastError } from "@/app/errors";
import { type Lookups, useLookups } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { BundleCard } from "@/components/inbox/outcome-card";
import { ProposalEditor } from "@/components/inbox/proposal-card";
import { isEditable } from "@/components/inbox/proposal-fields";
import { RevokeControl, RevokeOutcome } from "@/components/inbox/revoke-control";
import { SmallAskRow } from "@/components/inbox/small-ask-row";
import {
  useDecisions,
  useInvalidateAfterDecision,
  useThreadReply,
} from "@/components/inbox/use-inbox";
import { TicketLink } from "@/components/tickets/ticket-link";
import { TONE } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { inboxDetail, type ProposalView } from "@/services/inbox/queries";
import { DailyNote } from "@/services/note";
import type { ThreadSummary } from "@/services/note/cards";
import { threadRefs } from "@/services/proposals/thread-refs";
import type { BlockMark } from "./block-marks";
import {
  actionLines,
  type CardTone,
  cardEntries,
  cardHead,
  failedTurn,
  shownPayload,
} from "./card-content";
import type { NoteCardStore } from "./card-store";

const PILL: Record<CardTone, string> = {
  waiting: TONE.info,
  ok: TONE.success,
  warn: TONE.warning,
  bad: TONE.danger,
  note: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  muted: TONE.neutral,
};

type Props = {
  store: NoteCardStore;
  date: string;
  /** Today's note. */
  editable: boolean;
  /** A reading will come for new lines (today, with reading on). */
  reads: boolean;
  /** The summaries of the day's threads. */
  threads: ReadonlyMap<string, ThreadSummary>;
  /** Saves what is on screen, so Ask reads the stored note as shown. */
  flush: () => Promise<void>;
  /** Reads the note now (the page's Read now). */
  onReadNow: () => void;
  reading: boolean;
};

export const BlockCardLayer = memo(function BlockCardLayer({
  store,
  date,
  editable,
  reads,
  threads,
  flush,
  onReadNow,
  reading,
}: Props) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const mark = snap.shown ? snap.marks.get(snap.shown) : undefined;
  // The last card stays in place while it fades out; a card moving to another
  // block keeps the old place until the new one is measured, so it does not
  // close and reopen.
  const last = useRef<{ mark: BlockMark; anchor: NonNullable<typeof snap.anchor> } | null>(null);
  const wasOpen = useRef(false);
  const anchor = snap.anchor ?? (wasOpen.current && mark ? last.current?.anchor : null);
  const open = !!mark && !!anchor;
  if (open && mark && anchor) last.current = { mark, anchor };
  wasOpen.current = open;
  const shown = last.current;
  // The card took the focus (Mod-., or the user tabbed in): give it back to the text on close.
  const hadFocus = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  // Mod-. on a card already open, or moving the pin to another block: the focus goes in.
  useEffect(() => {
    if (!snap.focus || !open || !snap.shown) return;
    const el = content.current;
    if (!el || el.contains(document.activeElement)) return;
    hadFocus.current = true;
    const first = el.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
    );
    (first ?? el).focus();
  }, [snap.focus, snap.shown, open]);

  const invalidate = useInvalidateAfterDecision();
  const ask = useMutation({
    mutationFn: async (hash: string) => {
      // The stored note is what Ask reads: save what is on screen first.
      if (editable) await flush();
      return run(Effect.flatMap(DailyNote, (n) => n.ask(date, hash)));
    },
    onError: (e) => toastError(e),
    onSettled: () => invalidate(),
  });
  // One Ask at a time on the page.
  const asking = ask.isPending ? (ask.variables ?? null) : null;

  const a = shown?.anchor;
  return (
    <Popover open={open} onOpenChange={(o) => !o && store.unpin()}>
      <PopoverAnchor asChild>
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={a ? { top: a.top, left: a.left, width: a.width, height: a.height } : undefined}
        />
      </PopoverAnchor>
      {shown && a && (
        <PopoverContent
          ref={content}
          side={a.side}
          align="start"
          sideOffset={a.side === "right" ? 16 : 6}
          collisionPadding={12}
          aria-label="What the secretary did with this line"
          className="w-[min(360px,calc(100vw-24px))] gap-2 p-3 text-[13px] leading-snug"
          onOpenAutoFocus={(e) => {
            hadFocus.current = snap.focus;
            if (!snap.focus) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (hadFocus.current) store.focusEditor();
            hadFocus.current = false;
          }}
          onFocusCapture={() => {
            hadFocus.current = true;
            store.interact();
          }}
          onPointerDownCapture={() => store.interact()}
          onPointerEnter={() => store.pointerInCard(true)}
          onPointerLeave={() => store.pointerInCard(false)}
          onInteractOutside={(e) => {
            // The mark's own click toggles the pin.
            const t = e.target as Element | null;
            if (t?.closest?.(".cm-note-mark")) e.preventDefault();
          }}
        >
          <CardBody
            key={shown.mark.key}
            mark={shown.mark}
            thread={shown.mark.thread ? threads.get(shown.mark.thread) : undefined}
            editable={editable}
            reads={reads}
            onAsk={() => !asking && ask.mutate(shown.mark.hash)}
            asking={asking === shown.mark.hash}
            askBusy={asking !== null}
            onReadNow={onReadNow}
            reading={reading}
          />
        </PopoverContent>
      )}
    </Popover>
  );
});

function CardBody({
  mark,
  thread,
  editable,
  reads,
  onAsk,
  asking,
  askBusy,
  onReadNow,
  reading,
}: {
  mark: BlockMark;
  thread: ThreadSummary | undefined;
  editable: boolean;
  reads: boolean;
  onAsk: () => void;
  asking: boolean;
  askBusy: boolean;
  onReadNow: () => void;
  reading: boolean;
}) {
  const head = cardHead(mark, thread, { editable, reads });
  const readNow = (
    <Button size="sm" variant="outline" className="h-7" disabled={reading} onClick={onReadNow}>
      {reading ? <Loader2 className="animate-spin" /> : <BookOpenCheck />}
      Read this now
    </Button>
  );
  return (
    <>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-semibold text-foreground">{head.title}</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-px text-[11.5px] font-semibold",
            PILL[head.tone],
          )}
        >
          {head.pill}
        </span>
      </div>
      {head.changed && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="flex-1">Changed since it was read; not read yet.</span>
          {head.readNow && readNow}
        </div>
      )}
      {head.body === "thread" && mark.thread && <ThreadRows id={mark.thread} />}
      {head.body === "noted" && (
        <Muted>Kept as your words on the work item's timeline; nothing to do.</Muted>
      )}
      {head.body === "alone" && (
        <Muted>Read; nothing to do. It will not be read again unless you change it.</Muted>
      )}
      {head.body === "unread" && (
        <>
          <Muted>I read new lines a minute after you stop typing, or now if you ask.</Muted>
          {head.readNow && <div className="flex gap-2">{readNow}</div>}
        </>
      )}
      {head.body === "not_read" && (
        <Muted>
          {editable ? "Reading is off, so new lines are not read." : "This line was not read."}
        </Muted>
      )}
      {head.body === "private" && (
        <Muted>
          Lines under the private heading never reach a model. There is nothing to ask here; move
          the line out of the section if you want it read.
        </Muted>
      )}
      {head.ask && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-7" disabled={askBusy} onClick={onAsk}>
            {asking ? <Loader2 className="animate-spin" /> : <Sparkles />}
            Ask the secretary about this
          </Button>
        </div>
      )}
      {head.inbox && mark.thread && !head.reply && <InboxLink id={mark.thread} />}
    </>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground">{children}</p>
);

function InboxLink({ id, note }: { id: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{note}</span>
      <Link to="/inbox" search={{ item: id }} className="inline-flex items-center gap-1 underline">
        <Inbox className="size-3" /> Open in Inbox
      </Link>
    </div>
  );
}

/** The thread's rows, its failed turn, the reply box and the footer. */
function ThreadRows({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: queryKeys.inboxDetail(id),
    queryFn: ({ signal }) => run(inboxDetail(id), signal),
  });
  const lookups = useLookups();
  const { approveAll, retriage } = useDecisions();
  const { reply, answering, send, choose } = useThreadReply(id, detail.data?.proposals);
  const [text, setText] = useState("");
  const d = detail.data;
  if (detail.isPending)
    return <Loader2 className="m-2 size-4 animate-spin text-muted-foreground" />;
  if (!d) return <Muted>This thread no longer exists.</Muted>;
  const entries = cardEntries(d.proposals);
  // The thread's new contacts and teams, for names before they exist (D60).
  const threadLookups = { ...lookups, refs: threadRefs(d.proposals) };
  const pendingActions = d.proposals.filter(
    (p) => p.status === "pending" && p.kind !== "needs_clarification",
  ).length;
  // A turn that did not go through, whatever else the thread holds (as the Inbox shows it).
  const error = reply.isPending ? null : failedTurn(d.item, d.messages);
  const submit = () => {
    const t = text.trim();
    if (!t || reply.isPending) return;
    send({ parts: [{ type: "typed", text: t }] });
    setText("");
  };
  return (
    <>
      {d.item.summary && entries.length === 0 && <Muted>{d.item.summary}</Muted>}
      {entries.map((e) => {
        switch (e.type) {
          case "action":
            return <ActionRow key={e.proposal.id} proposal={e.proposal} lookups={threadLookups} />;
          case "done":
            return <DoneRow key={e.proposal.id} proposal={e.proposal} />;
          case "question":
            return (
              <QuestionRow
                key={e.proposal.id}
                proposal={e.proposal}
                answering={answering?.id === e.proposal.id}
                onChoose={reply.isPending ? undefined : choose}
              />
            );
          case "track":
            return (
              <SmallAskRow
                key={e.create.id}
                create={e.create}
                members={e.members}
                lookups={threadLookups}
              />
            );
          case "bundle":
            return (
              <BundleCard
                key={e.bundleId}
                bundleId={e.bundleId}
                situation={d.bundles[e.bundleId] ?? null}
                proposals={e.proposals}
              />
            );
        }
        return null;
      })}
      {pendingActions > 1 && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={approveAll.isPending}
            onClick={() => approveAll.mutate(id)}
          >
            {approveAll.isPending ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            Approve all ({pendingActions})
          </Button>
        </div>
      )}
      {error && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground">{error}</p>
          <Button
            size="sm"
            className="h-7"
            disabled={retriage.isPending}
            onClick={() => retriage.mutate(id)}
          >
            {retriage.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Try again
          </Button>
        </div>
      )}
      <form
        className="mt-1 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          className="h-8 text-[13px]"
          value={text}
          disabled={reply.isPending}
          aria-label="Tell the secretary"
          placeholder={answering ? "Or answer in your own words…" : "Tell the secretary…"}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={reply.isPending || !text.trim()}
        >
          {reply.isPending ? <Loader2 className="animate-spin" /> : <Send />}
          Send
        </Button>
      </form>
      {reply.isPending && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {reply.progress ?? "Working..."}
        </p>
      )}
      <InboxLink id={id} note={`Note thread · ${relativeTime(d.item.receivedAt)}`} />
    </>
  );
}

type Result = { message?: string; error?: string; issueKey?: string; warning?: string } | null;

const Row = ({ children, kind }: { children: ReactNode; kind: string }) => (
  <div className="flex flex-col gap-1 rounded-md border px-2.5 py-2">
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {kind}
    </span>
    {children}
  </div>
);

/** A waiting card in one row: Approve (at once, as in the Inbox), Edit, Reject; Retry when it failed. */
function ActionRow({ proposal, lookups }: { proposal: ProposalView; lookups: Lookups }) {
  const { approve, reject, saveEdit } = useDecisions();
  const [editing, setEditing] = useState(false);
  const payload = shownPayload(proposal);
  const lines = actionLines(payload);
  const failed = proposal.status === "failed";
  const busy = approve.isPending || reject.isPending;
  const error = (proposal.result as Result)?.error;
  return (
    <Row kind={lines.kind}>
      <p className="break-words">{lines.what}</p>
      {failed && error && <p className="text-destructive">{error}</p>}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-7"
          disabled={busy}
          onClick={() => approve.mutate({ id: proposal.id })}
        >
          {approve.isPending ? (
            <Loader2 className="animate-spin" />
          ) : failed ? (
            <RotateCcw />
          ) : (
            <Check />
          )}
          {failed ? "Retry" : "Approve"}
        </Button>
        {isEditable(payload) && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            <Pencil /> Edit
          </Button>
        )}
        {proposal.status === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={busy}
            onClick={() => reject.mutate(proposal.id)}
          >
            <X /> Reject
          </Button>
        )}
      </div>
      <ProposalEditor
        proposal={proposal}
        lookups={lookups}
        open={editing}
        onOpenChange={setEditing}
        busy={busy}
        approve={approve}
        saveEdit={saveEdit}
      />
    </Row>
  );
}

/** What was done: the ticket it made or the change, and Undo where the Inbox offers Revoke. */
function DoneRow({ proposal }: { proposal: ProposalView }) {
  const lines = actionLines(shownPayload(proposal));
  const result = proposal.result as Result;
  return (
    <Row kind={`${lines.kind} · done`}>
      <p className="break-words">{lines.what}</p>
      {result?.warning && <p className="text-amber-700 dark:text-amber-300">{result.warning}</p>}
      <div className="flex items-center gap-1.5">
        {result?.issueKey && (
          <Button size="sm" variant="outline" className="h-7" asChild>
            <TicketLink ticketKey={result.issueKey}>Open {result.issueKey}</TicketLink>
          </Button>
        )}
        <span className="flex-1" />
        <RevokeControl proposal={proposal} label="Undo" />
      </div>
      <RevokeOutcome result={proposal.result} />
    </Row>
  );
}

/** A question: its choices answer it at once (as the Inbox's choice does); Leave it skips it. */
function QuestionRow({
  proposal,
  answering,
  onChoose,
}: {
  proposal: ProposalView;
  answering: boolean;
  onChoose?: (proposalId: string, choice: string) => void;
}) {
  const { reject } = useDecisions();
  const p = proposal.payload;
  if (p.kind !== "needs_clarification") return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p>{p.question}</p>
      <div className="flex flex-wrap gap-1.5">
        {p.choices.map((c) => (
          <Button
            key={c}
            size="sm"
            variant="outline"
            className="h-7"
            disabled={!onChoose}
            onClick={() => onChoose?.(proposal.id, c)}
          >
            {c}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={reject.isPending}
          onClick={() => reject.mutate(proposal.id)}
        >
          Leave it
        </Button>
      </div>
      {answering && (
        <span className="text-xs text-muted-foreground">A reply below answers this.</span>
      )}
    </div>
  );
}

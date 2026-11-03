/**
 * The Work tab of the ticket view (FR-19, D61): the work item the ticket
 * belongs to, its status note (editable), its tickets, the timeline, and the
 * user's changes: rename, split, merge, move a ticket, the item they are on.
 * Everything here is local; nothing writes to Jira.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Effect } from "effect";
import {
  AlertTriangle,
  Check,
  GitMerge,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Scissors,
  Star,
  X,
} from "lucide-react";
import { useState } from "react";
import { useAppMutation, useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";
import { requestWorkPass } from "@/app/work";
import { StatusBadge } from "@/components/tickets/status-badge";
import { TicketLink } from "@/components/tickets/ticket-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { localDate } from "@/lib/dates";
import { onSelect } from "@/lib/select-change";
import { dateTime, relativeTime, shortDate } from "@/lib/time";
import { NEXT_LIMIT } from "@/services/work/next";
import { movesOfItem } from "@/services/work/next-query";
import { resumeRule } from "@/services/work/outcomes";
import {
  addNote,
  editNote,
  mergeItems,
  moveTicket,
  renameItem,
  setCurrent,
  splitItem,
  type WorkItemDetail,
  workItemDetail,
} from "@/services/work/queries";
import { RULE_LABELS, type RuleName } from "@/services/work/rules";
import { NextMoves } from "./next-moves";

const NEW_ITEM = "__new__";

/** What each event kind is called on the timeline. */
const KIND_LABEL: Record<string, string> = {
  message: "Inbox",
  proposal_executed: "Approved",
  proposal_failed: "Failed",
  proposal_revoked: "Revoked",
  jira_change: "Jira",
  jira_comment: "Comment",
  draft_sent: "Sent",
  wait_opened: "Wait",
  wait_chased: "Chased",
  wait_rescheduled: "Wait",
  wait_resolved: "Wait",
  wait_dropped: "Wait",
  ticket_viewed: "Opened",
  ticket_edited: "You edited",
  note: "Your note",
  answer: "Your answer",
  correction: "Changed",
  outcome_offered: "Follow-up",
  outcome_dismissed: "Dismissed",
  rule_resumed: "Changed",
  parked: "Parked",
  unparked: "Back",
  day_end: "End of day",
};

function useWorkMutation<I, A, E>(f: (input: I) => Effect.Effect<A, E, AppServices>) {
  return useAppMutation(f, {
    // The Inbox marks threads against the current item (D62).
    invalidate: [queryKeys.tickets, queryKeys.memories, queryKeys.inbox],
    onSuccess: requestWorkPass,
  });
}

function StatusNote({ detail }: { detail: WorkItemDetail }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(detail.note);
  const save = useWorkMutation((t: string) => editNote(detail.item.id, t));
  if (editing)
    return (
      <div className="flex flex-col gap-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus />
        <p className="text-xs text-muted-foreground">
          Your words stay as they are until something they name changes in Jira or a wait.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(text, { onSuccess: () => setEditing(false) })}
          >
            <Check /> Save note
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">
        {detail.note || <span className="text-muted-foreground">Nothing known yet.</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {detail.item.noteEdited ? <span>You wrote this note.</span> : null}
        {detail.item.stateUpdatedAt && (
          <span title={dateTime(detail.item.stateUpdatedAt)}>
            Updated {relativeTime(detail.item.stateUpdatedAt)}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7"
          onClick={() => {
            setText(detail.note);
            setEditing(true);
          }}
        >
          <Pencil /> Edit note
        </Button>
        {detail.item.noteEdited && (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => save.mutate("")}>
            Use the secretary's note
          </Button>
        )}
      </div>
    </div>
  );
}

function Rename({ detail }: { detail: WorkItemDetail }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(detail.item.name);
  const rename = useWorkMutation((n: string) => renameItem(detail.item.id, n));
  if (!editing)
    return (
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate font-medium">{detail.item.name}</h3>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Rename the work item"
          onClick={() => {
            setName(detail.item.name);
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
    );
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        rename.mutate(name, { onSuccess: () => setEditing(false) });
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" autoFocus />
      <Button size="icon" type="submit" className="size-8" aria-label="Save name">
        <Check />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        type="button"
        className="size-8"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
      >
        <X />
      </Button>
    </form>
  );
}

function SplitDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: WorkItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const split = useWorkMutation((keys: string[]) => splitItem(detail.item.id, keys));
  const keys = detail.facts.tickets.map((t) => t.key);
  // A new item needs one of the user's own tickets (D61).
  const primary = detail.facts.tickets.filter((t) => t.role === "primary").map((t) => t.key);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Split off a new work item</DialogTitle>
          <DialogDescription>
            Pick the tickets that are a separate piece of work. They stay apart from the rest from
            now on.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {detail.facts.tickets.map((t) => (
            <li key={t.key} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`split-${t.key}`}
                checked={picked.includes(t.key)}
                onCheckedChange={(c) =>
                  setPicked((p) => (c ? [...p, t.key] : p.filter((k) => k !== t.key)))
                }
              />
              <Label htmlFor={`split-${t.key}`} className="font-normal">
                <span className="font-mono text-xs">{t.key}</span> {t.summary}
              </Label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            disabled={
              !picked.some((k) => primary.includes(k)) ||
              picked.length === keys.length ||
              split.isPending
            }
            onClick={() =>
              split.mutate(picked, {
                onSuccess: () => {
                  setPicked([]);
                  onOpenChange(false);
                },
              })
            }
          >
            <Scissors /> Split off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The item menu: "Ask again about ..." for each follow-up rule the user
 * dismissed twice on this item (Phase 25). Shown only when one is quiet.
 */
function ItemMenu({ detail }: { detail: WorkItemDetail }) {
  const resume = useWorkMutation((rule: RuleName) => resumeRule(detail.item.id, rule));
  if (detail.quiet.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8" aria-label="Work item menu">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Follow-ups you dismissed twice here
        </DropdownMenuLabel>
        {detail.quiet.map((rule) => (
          <DropdownMenuItem key={rule} onSelect={() => resume.mutate(rule)}>
            Ask again about {RULE_LABELS[rule].name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MergeSelect({ detail }: { detail: WorkItemDetail }) {
  const merge = useWorkMutation((into: string) => mergeItems(detail.item.id, into));
  if (detail.others.length === 0) return null;
  return (
    <Select value="" onValueChange={onSelect((v) => merge.mutate(v))}>
      <SelectTrigger size="sm" className="h-8 w-auto gap-1" aria-label="Merge into another item">
        <GitMerge className="size-3.5" />
        <SelectValue placeholder="Merge into" />
      </SelectTrigger>
      <SelectContent>
        {detail.others.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MoveSelect({
  detail,
  issueKey,
  related,
}: {
  detail: WorkItemDetail;
  issueKey: string;
  /** A ticket the item waits on: it moves only into another item. */
  related: boolean;
}) {
  const move = useWorkMutation((to: string) => moveTicket(issueKey, to === NEW_ITEM ? null : to));
  if (related && detail.others.length === 0) return null;
  return (
    <Select value="" onValueChange={onSelect((v) => move.mutate(v))}>
      <SelectTrigger size="sm" className="h-7 w-auto text-xs" aria-label={`Move ${issueKey}`}>
        <SelectValue placeholder="Move" />
      </SelectTrigger>
      <SelectContent>
        {!related && <SelectItem value={NEW_ITEM}>A new work item</SelectItem>}
        {detail.others.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Tickets({ detail }: { detail: WorkItemDetail }) {
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {detail.facts.tickets.map((t) => (
        <li key={t.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <TicketLink ticketKey={t.key} />
          <span className="min-w-0 flex-1 truncate">{t.summary ?? ""}</span>
          {t.role === "related" && <Badge variant="outline">waits on it</Badge>}
          {t.status && (
            <StatusBadge
              status={t.status}
              category={
                (["new", "indeterminate", "done"].includes(t.statusCategory ?? "")
                  ? t.statusCategory
                  : "new") as "new"
              }
            />
          )}
          {detail.facts.tickets.length > 1 && (
            <MoveSelect detail={detail} issueKey={t.key} related={t.role === "related"} />
          )}
        </li>
      ))}
    </ul>
  );
}

function StateLists({ detail }: { detail: WorkItemDetail }) {
  const s = detail.state;
  if (!s) return null;
  const name = (id: string | null, fallback: string | null) =>
    (id && detail.people.get(id)) || fallback || "someone";
  const open = s.commitments.filter((c) => c.status === "open");
  return (
    <div className="grid gap-4 text-sm sm:grid-cols-2">
      {open.length > 0 && (
        <section>
          <h4 className="mb-1 font-medium">Promises</h4>
          <ul className="flex flex-col gap-1">
            {open.map((c) => (
              <li key={`${c.saidIn}-${c.what}`}>
                {c.what}{" "}
                <span className="text-muted-foreground">to {name(c.toPersonId, c.toName)}</span>
                {c.dueOn && <span className="text-muted-foreground"> by {shortDate(c.dueOn)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.openQuestions.length > 0 && (
        <section>
          <h4 className="mb-1 font-medium">Still to find out</h4>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {s.openQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      )}
      {s.people.length > 0 && (
        <section>
          <h4 className="mb-1 font-medium">People</h4>
          <ul className="flex flex-col gap-1">
            {s.people.map((p) => (
              <li key={`${p.personId ?? p.name}-${p.role}`}>
                {name(p.personId, p.name)} <span className="text-muted-foreground">{p.role}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AddNote({ detail }: { detail: WorkItemDetail }) {
  const [text, setText] = useState("");
  const add = useWorkMutation((t: string) => addNote(detail.item.id, t));
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) add.mutate(text, { onSuccess: () => setText("") });
      }}
    >
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Tell the secretary where this stands ("I'm on the cert now")`}
        className="h-8"
      />
      <Button size="sm" type="submit" variant="outline" disabled={!text.trim() || add.isPending}>
        Add note
      </Button>
    </form>
  );
}

function Timeline({ detail }: { detail: WorkItemDetail }) {
  if (detail.timeline.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing has happened here yet.</p>;
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {detail.timeline.map((e) => (
        <li key={e.id} className="flex gap-2">
          <time
            className="w-20 shrink-0 text-xs text-muted-foreground"
            dateTime={e.at}
            title={dateTime(e.at)}
          >
            {relativeTime(e.at)}
          </time>
          <Badge variant="outline" className="h-5 shrink-0 font-normal">
            {KIND_LABEL[e.kind] ?? e.kind}
          </Badge>
          <span className="min-w-0">
            {e.summary}
            {e.attachedBy === "unsure" && (
              <span className="text-muted-foreground"> (not sure it belongs here; not used)</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The "Next" strip (D62): the item's next moves, ranked by code from the
 * dates the app holds, at most five. Hidden while suggestions are off.
 */
function NextStrip({ itemId }: { itemId: string }) {
  const { data: settings } = useSettings();
  const today = localDate();
  const on = settings?.secretary.suggestions ?? false;
  const next = useQuery({
    queryKey: queryKeys.workNext(itemId, today),
    queryFn: ({ signal }) => run(movesOfItem(itemId, today), signal),
    enabled: on,
  });
  if (!on || !next.data || next.data.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <h4 className="text-sm font-medium">Next</h4>
      <NextMoves moves={next.data.slice(0, NEXT_LIMIT)} />
    </section>
  );
}

export function WorkTab({ issueKey }: { issueKey: string }) {
  const [splitting, setSplitting] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.workItem(issueKey),
    queryFn: ({ signal }) => run(workItemDetail(issueKey), signal),
  });
  const current = useWorkMutation((id: string | null) => setCurrent(id));
  const d = detail.data;
  if (detail.isPending) return null;
  if (!d)
    return (
      <p className="text-sm text-muted-foreground">
        This ticket is in no work item yet. It joins one when it is active for you: assigned to you
        and in progress or in the sprint, a small ask, or something you acted on from the app.
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Rename detail={d} />
        {d.item.status !== "active" && <Badge variant="secondary">{d.item.status}</Badge>}
        {d.item.needsLook && (
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="size-3" /> Needs your look
          </Badge>
        )}
        <Button
          size="sm"
          variant={d.item.current ? "secondary" : "outline"}
          className="ml-auto h-8"
          onClick={() => current.mutate(d.item.current ? null : d.item.id)}
        >
          <Star className={d.item.current ? "fill-current" : undefined} />
          {d.item.current ? "You are on this" : "I'm on this now"}
        </Button>
        <ItemMenu detail={d} />
      </div>
      {d.item.needsLook && (
        <p className="text-sm text-muted-foreground">
          The last update did not check out against the facts, so the note below is from before it.
          Have a look, and edit the note if it is out of date.
        </p>
      )}
      {d.item.status === "active" && <NextStrip itemId={d.item.id} />}
      <StatusNote key={`${d.item.id}-${d.note}`} detail={d} />
      <StateLists detail={d} />
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-medium">Tickets</h4>
          <div className="ml-auto flex gap-2">
            {d.facts.tickets.length > 1 && (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => setSplitting(true)}
              >
                <Scissors /> Split
              </Button>
            )}
            <MergeSelect detail={d} />
          </div>
        </div>
        <Tickets detail={d} />
      </section>
      <AddNote detail={d} />
      {d.threadId && (
        <Link
          to="/inbox"
          search={{ item: d.threadId }}
          className="inline-flex items-center gap-1 text-sm underline"
        >
          <MessageSquare className="size-3.5" /> Questions about this work in the Inbox
        </Link>
      )}
      <section className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Timeline</h4>
        <Timeline detail={d} />
      </section>
      <SplitDialog detail={d} open={splitting} onOpenChange={setSplitting} />
    </div>
  );
}

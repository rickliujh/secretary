/**
 * Today's three lists (D49). Each row says why it is there and carries its
 * actions; a list longer than `SHOWN` folds the rest behind "Show all".
 */
import { Link } from "@tanstack/react-router";
import { CheckCheck, Clock, MessagesSquare, Pin, Send, Star } from "lucide-react";
import { type ReactNode, useState } from "react";
import { FollowupDialog } from "@/components/dependencies/followup-dialog";
import { useChaseDraft } from "@/components/drafts/use-drafts";
import { VerdictLine } from "@/components/inbox/sprint-choice";
import { useUserSprintLoad } from "@/components/inbox/use-sprint-fit";
import { TicketLink, useTicketPanel } from "@/components/tickets/ticket-link";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { resolveWait, snoozeTicket, snoozeWait } from "@/services/dashboard/actions";
import type { DashIssue } from "@/services/dashboard/sections";
import {
  type BlockedRow,
  type SprintRow,
  type ThreadRow,
  type TicketRow,
  type Today,
  type WaitRow,
  type WorkItemRef,
  waitSnoozeAfter,
} from "@/services/dashboard/today";
import {
  DoneButton,
  IconAction,
  MoreMenu,
  ReplyButton,
  SnoozeDateDialog,
  SnoozeItems,
} from "./row-actions";
import { useRowAction } from "./use-today";
import { RankingItems, WhyHere } from "./why-here";

/** Rows shown before "Show all". */
const SHOWN = 12;

export function ListCard({
  title,
  description,
  count,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <h2>{title}</h2>
          {count > 0 && (
            <Badge variant="secondary" className="tabular-nums">
              {count}
            </Badge>
          )}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/** A list with its empty line and the fold. */
function Rows<T>({
  rows,
  empty,
  render,
  rowKey,
}: {
  rows: readonly T[];
  empty: ReactNode;
  render: (row: T) => ReactNode;
  rowKey: (row: T) => string;
}) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <>
      <ul className="flex flex-col">
        {shown.map((r) => (
          <li key={rowKey(r)} className="border-b py-1.5 last:border-b-0">
            {render(r)}
          </li>
        ))}
      </ul>
      {rows.length > SHOWN && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </Button>
      )}
    </>
  );
}

/** One row: what it is on the first line with its actions, why it is here on the second. */
function Row({
  head,
  why,
  actions,
  workItem,
}: {
  head: ReactNode;
  why: ReactNode;
  actions?: ReactNode;
  /** The work item the row's ticket belongs to (D61). */
  workItem?: WorkItemRef;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">{head}</div>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {workItem && (
          <Badge
            variant="outline"
            className="max-w-48 gap-1 font-normal"
            title={
              workItem.current ? `You are on: ${workItem.name}` : `Work item: ${workItem.name}`
            }
          >
            {workItem.current && (
              <Star className="size-3 fill-current" aria-label="You are on this" />
            )}
            <span className="truncate">{workItem.name}</span>
          </Badge>
        )}
        {why}
      </div>
    </div>
  );
}

function IssueHead({ issue }: { issue: Pick<DashIssue, "key" | "summary"> }) {
  return (
    <>
      <TicketLink ticketKey={issue.key} className="shrink-0">
        {issue.key}
      </TicketLink>
      <span className="min-w-0 truncate" title={issue.summary}>
        {issue.summary}
      </span>
    </>
  );
}

const Why = ({ children }: { children: ReactNode }) => (
  <span className="min-w-0 break-words">{children}</span>
);

function useTicketSnooze({
  issue,
  sprintEnd,
}: {
  issue: Pick<DashIssue, "key">;
  sprintEnd: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const act = useRowAction((day: string) => snoozeTicket(issue.key, day));
  return {
    busy: act.isPending,
    items: (
      <SnoozeItems
        sprintEnd={sprintEnd}
        onPick={(d) => act.mutate(d)}
        onPickDate={() => setPicking(true)}
      />
    ),
    dialog: (
      <SnoozeDateDialog
        open={picking}
        onOpenChange={setPicking}
        title={`Snooze ${issue.key}`}
        onPick={(d) => act.mutate(d)}
      />
    ),
  };
}

function TicketActions({
  issue,
  sprintEnd,
  done = true,
  reply = true,
  extra,
}: {
  issue: DashIssue;
  sprintEnd: string | null;
  done?: boolean;
  reply?: boolean;
  extra?: ReactNode;
}) {
  const snooze = useTicketSnooze({ issue, sprintEnd });
  const open = useTicketPanel();
  return (
    <>
      {done && <DoneButton issueKey={issue.key} />}
      {reply && <ReplyButton issue={issue} />}
      <MoreMenu label={`More actions for ${issue.key}`} busy={snooze.busy}>
        <DropdownMenuItem onSelect={() => void open(issue.key)}>Open ticket</DropdownMenuItem>
        {snooze.items}
        {extra}
      </MoreMenu>
      {snooze.dialog}
    </>
  );
}

const KIND_BADGE: Record<TicketRow["kind"], { label: string; tone: keyof typeof TONE } | null> = {
  woken: { label: "unblocked", tone: "success" },
  ask: null,
  comment: null,
};

function TicketItem({ row, sprintEnd }: { row: TicketRow; sprintEnd: string | null }) {
  const badge = KIND_BADGE[row.kind];
  return (
    <Row
      workItem={row.workItem}
      head={<IssueHead issue={row.issue} />}
      actions={<TicketActions issue={row.issue} sprintEnd={sprintEnd} />}
      why={
        <>
          {badge && (
            <Badge variant="secondary" className={cn("border-transparent", TONE[badge.tone])}>
              {badge.label}
            </Badge>
          )}
          {row.smallAsk && row.kind !== "ask" && <Badge variant="outline">small ask</Badge>}
          <Why>
            {row.reason}
            {row.kind === "comment" && ` ${relativeTime(row.at)}`}
          </Why>
        </>
      }
    />
  );
}

function ThreadItem({ row }: { row: ThreadRow }) {
  const t = row.thread;
  return (
    <Row
      workItem={row.workItem}
      head={
        <>
          <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <Link
            to="/inbox"
            search={{ item: t.id }}
            className="min-w-0 truncate underline-offset-2 hover:underline"
            title={t.summary ?? "Inbox thread"}
          >
            {t.summary ?? "Inbox thread"}
          </Link>
        </>
      }
      actions={
        <Button asChild variant="ghost" size="sm" className="h-7">
          <Link to="/inbox" search={{ item: t.id }}>
            Open
          </Link>
        </Button>
      }
      why={
        <Why>
          {row.reason}
          {t.sender && `, from ${t.sender}`}
        </Why>
      }
    />
  );
}

export function YourMove({ today }: { today: Today }) {
  return (
    <ListCard
      title="Your move"
      count={today.yourMove.length}
      description="Woken tickets, small asks, comments and Inbox decisions."
    >
      <Rows
        rows={today.yourMove}
        empty="Nothing waits on you."
        rowKey={(r) => (r.kind === "thread" ? `t:${r.thread.id}` : r.issue.key)}
        render={(r) =>
          r.kind === "thread" ? (
            <ThreadItem row={r} />
          ) : (
            <TicketItem row={r} sprintEnd={today.sprintEnd} />
          )
        }
      />
      {!today.smallAsks.home && (
        <p className="mt-2 text-xs text-muted-foreground">
          Small asks are not tracked yet.{" "}
          <Link to="/settings" search={{ tab: "jira" }} className="underline">
            Set a home in Settings
          </Link>
          .
        </p>
      )}
    </ListCard>
  );
}

const WAIT_TONE: Record<WaitRow["state"], string> = {
  overdue: TONE.danger,
  followup: TONE.warning,
  back: TONE.info,
  open: "",
  asleep: "",
};

function WaitItem({ row, sprintEnd }: { row: WaitRow; sprintEnd: string | null }) {
  const d = row.dependency;
  const chase = useChaseDraft();
  const [logging, setLogging] = useState(false);
  const [picking, setPicking] = useState(false);
  const resolve = useRowAction(() => resolveWait(d.id, d.label));
  const snooze = useRowAction((day: string) => snoozeWait(d.id, d.label, day));
  const busy = resolve.isPending || snooze.isPending;
  const after = waitSnoozeAfter(row.timing);
  return (
    <>
      <Row
        workItem={row.workItem}
        head={
          <>
            <Link
              to="/waiting"
              search={{ id: d.id }}
              className="min-w-0 truncate underline-offset-2 hover:underline"
              title={d.label}
            >
              {d.label}
            </Link>
            {d.externalRef && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {d.externalRef}
              </span>
            )}
          </>
        }
        actions={
          <>
            <IconAction
              label={`Draft a chase to ${d.ownerName}`}
              busy={chase.isPending}
              onClick={() => chase.mutate(d.id)}
            >
              <Send />
            </IconAction>
            <MoreMenu label={`More actions for ${d.label}`} busy={busy}>
              <DropdownMenuItem onSelect={() => setLogging(true)}>Log a reply...</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => resolve.mutate()}>
                <CheckCheck /> Resolve
              </DropdownMenuItem>
              <SnoozeItems
                label="Chase later"
                after={after}
                sprintEnd={sprintEnd}
                onPick={(day) => snooze.mutate(day)}
                onPickDate={() => setPicking(true)}
              />
            </MoreMenu>
          </>
        }
        why={
          <>
            {WAIT_TONE[row.state] ? (
              <Badge
                variant="secondary"
                title={row.reason}
                className={cn("max-w-full border-transparent", WAIT_TONE[row.state])}
              >
                <span className="truncate">{row.reason}</span>
              </Badge>
            ) : (
              <Why>{row.reason}</Why>
            )}
            <span>· {d.ownerName}</span>
            <span>
              ·{" "}
              <TicketLink ticketKey={d.issueKey} className="text-xs">
                {d.issueKey}
              </TicketLink>
            </span>
          </>
        }
      />
      <FollowupDialog
        dependencyId={d.id}
        open={logging}
        onOpenChange={setLogging}
        title={`Log a reply from ${d.ownerName}`}
        description="What they said, and when to chase next if it is not done."
      />
      <SnoozeDateDialog
        open={picking}
        onOpenChange={setPicking}
        title={`Chase ${d.label} later`}
        after={after}
        onPick={(day) => snooze.mutate(day)}
      />
    </>
  );
}

function BlockedItem({ row, sprintEnd }: { row: BlockedRow; sprintEnd: string | null }) {
  return (
    <Row
      workItem={row.workItem}
      head={<IssueHead issue={row.issue} />}
      actions={<TicketActions issue={row.issue} sprintEnd={sprintEnd} done={false} reply={false} />}
      why={
        <>
          {row.asleep && <Clock className="size-3" role="img" aria-label="snoozed" />}
          <span>blocked by</span>
          {row.blockedBy.slice(0, 3).map((k) => (
            <TicketLink key={k} ticketKey={k} className="text-xs">
              {k}
            </TicketLink>
          ))}
          {row.blockedBy.length > 3 && <span>and {row.blockedBy.length - 3} more</span>}
          {row.asleep && <Why>{row.reason.replace(/^.*; /, "· ")}</Why>}
        </>
      }
    />
  );
}

export function TheirMove({ today }: { today: Today }) {
  return (
    <ListCard
      title="Their move"
      count={today.theirMove.length}
      description="Waits, most pressing first, and your tickets blocked by others."
      action={
        <Link to="/waiting" className="text-sm underline">
          All waits
        </Link>
      }
    >
      <Rows
        rows={today.theirMove}
        empty="You are not waiting on anyone."
        rowKey={(r) => (r.kind === "wait" ? `w:${r.dependency.id}` : r.issue.key)}
        render={(r) =>
          r.kind === "wait" ? (
            <WaitItem row={r} sprintEnd={today.sprintEnd} />
          ) : (
            <BlockedItem row={r} sprintEnd={today.sprintEnd} />
          )
        }
      />
    </ListCard>
  );
}

function SprintItem({ row, sprintEnd }: { row: SprintRow; sprintEnd: string | null }) {
  const i = row.issue;
  const late = row.daysLeft !== null && row.daysLeft < 0;
  return (
    <Row
      workItem={row.workItem}
      head={<IssueHead issue={i} />}
      actions={
        <>
          <WhyHere item={i} />
          <TicketActions
            issue={i}
            sprintEnd={sprintEnd}
            reply={false}
            extra={<RankingItems item={i} />}
          />
        </>
      }
      why={
        <>
          {i.pinned && <Pin className="size-3" role="img" aria-label="pinned" />}
          {row.daysLeft !== null && (
            <Badge
              variant="secondary"
              className={cn("border-transparent tabular-nums", late ? TONE.danger : TONE.warning)}
            >
              {late
                ? `${-row.daysLeft}d late`
                : row.daysLeft === 0
                  ? "due today"
                  : `due in ${row.daysLeft}d`}
            </Badge>
          )}
          {row.risks.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Focusable, so the reasons reach keyboard and screen reader users too. */}
                <Badge
                  variant="secondary"
                  tabIndex={0}
                  aria-label={`At risk: ${row.risks.join("; ")}`}
                  className={cn("border-transparent", TONE.warning)}
                >
                  at risk
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{row.risks.join("; ")}</TooltipContent>
            </Tooltip>
          )}
          <Why>{row.reason}</Why>
          <span>· {i.status}</span>
        </>
      }
    />
  );
}

/** The user's sprint load in days with its verdict, no ticket added (D57). */
function SprintLoad() {
  const load = useUserSprintLoad();
  const { sprint, fit } = load.data ?? {};
  if (!sprint || !fit) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2">
      {/* The description above already names the sprint and its end date. */}
      <span>
        {sprint.ended
          ? "Ended, not closed yet."
          : `${sprint.daysLeft} working ${sprint.daysLeft === 1 ? "day" : "days"} left.`}
      </span>
      <VerdictLine fit={fit} sprint={sprint} />
    </div>
  );
}

export function SprintWork({ today }: { today: Today }) {
  const f = today.focus;
  return (
    <ListCard
      title="Sprint work"
      count={today.sprintWork.length}
      description={
        f.mode === "sprint" ? (
          <>
            {`${f.sprints.join(" and ")}${f.endsOn ? `, ending ${f.endsOn}` : ""}${today.snoozed ? `; ${today.snoozed} snoozed` : ""}.`}
            <SprintLoad />
          </>
        ) : (
          `No active sprint: ranked from ${today.inScope} open tickets in scope${today.snoozed ? `; ${today.snoozed} snoozed` : ""}.`
        )
      }
    >
      <Rows
        rows={today.sprintWork}
        empty={
          f.mode === "sprint"
            ? "Nothing else planned in the sprint."
            : "Nothing assigned to you or under your tracked epics."
        }
        rowKey={(r) => r.issue.key}
        render={(r) => <SprintItem row={r} sprintEnd={today.sprintEnd} />}
      />
    </ListCard>
  );
}

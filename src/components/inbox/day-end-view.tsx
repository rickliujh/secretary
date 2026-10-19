/**
 * The day's end-of-day page in the Inbox (FR-19.9, D63): the markdown code
 * wrote, then the questions the rules could not settle, each with its choice
 * buttons. A choice answers in the question's own work thread through
 * `Intake.reply`, as it would there. Done files the page; Run again writes it
 * anew and looks at the questions again (on an older page, it writes today's
 * and opens it). Links other than ticket links render as text.
 */
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, HelpCircle, Loader2, RefreshCw } from "lucide-react";
import { useAppMutation, useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { runDayEndNow } from "@/app/work";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { localDate } from "@/lib/dates";
import { dateTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { InboxDetail } from "@/services/inbox/queries";
import { closeDayEnd, type DayEndQuestion } from "@/services/work/dayend-query";
import { useReply } from "./use-inbox";

function Question({ q }: { q: DayEndQuestion }) {
  const reply = useReply();
  const pending = q.status === "pending";
  const choose = (choice: string) => {
    if (!q.threadId) return;
    reply.mutate({
      inboxItemId: q.threadId,
      parts: [{ type: "typed", text: choice }],
      answers: q.id,
    });
  };
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3 text-sm",
        pending ? "border-amber-500/40 bg-amber-500/5" : "border-dashed text-muted-foreground",
      )}
    >
      {q.itemName && <span className="text-xs text-muted-foreground">{q.itemName}</span>}
      <p className="font-medium">
        <HelpCircle className="mr-1 inline size-4 text-amber-600" />
        {q.question}
      </p>
      {q.answer && <p>You answered: {q.answer}</p>}
      {!pending && !q.answer && <p>Settled in its thread.</p>}
      {pending && q.choices.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {q.choices.map((c) => (
            <Button
              key={c}
              size="sm"
              variant="outline"
              className="h-7"
              disabled={reply.isPending || !q.threadId}
              onClick={() => choose(c)}
            >
              {c}
            </Button>
          ))}
          {reply.isPending && <Loader2 className="size-4 animate-spin self-center" />}
        </div>
      )}
      {q.threadId && (
        <Link to="/inbox" search={{ item: q.threadId }} className="self-start text-xs underline">
          {pending ? "Answer in words in its thread" : "Open its thread"}
        </Link>
      )}
    </li>
  );
}

export function DayEndView({ detail }: { detail: InboxDetail }) {
  const dayEnd = detail.dayEnd;
  const open = detail.item.status === "triaged";
  const onError = useErrorToast();
  const done = useAppMutation((id: string) => closeDayEnd(id), {
    invalidate: [queryKeys.inbox],
  });
  const navigate = useNavigate();
  // Only today's page is written again; an older one leads to today's.
  const isToday = dayEnd?.record.date === localDate();
  const again = useMutation({
    mutationFn: () => runDayEndNow("button"),
    onSuccess: (r) => {
      if (!r.skipped && r.id !== detail.item.id)
        void navigate({ to: "/inbox", search: { item: r.id } });
    },
    onError: (e) => onError(e),
  });
  const questions = dayEnd?.questions ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">Secretary</Badge>
          <span>End of day</span>
          <span title={dateTime(detail.item.receivedAt)}>
            {relativeTime(detail.item.receivedAt)}
          </span>
          {!open && <Badge variant="secondary">{detail.item.status}</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {open && (
            <Button size="sm" disabled={done.isPending} onClick={() => done.mutate(detail.item.id)}>
              <Check /> Done
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={again.isPending}
            onClick={() => again.mutate()}
          >
            {again.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {isToday ? "Run again" : "Today's end of day"}
          </Button>
        </div>
      </header>
      {/* Others' words are quoted here: no link but a ticket link, no image (D63). */}
      <Markdown linkTickets linksAsText>
        {detail.item.rawText}
      </Markdown>
      {questions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {questions.map((q) => (
            <Question key={q.id} q={q} />
          ))}
        </ul>
      )}
    </div>
  );
}

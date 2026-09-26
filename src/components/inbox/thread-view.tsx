import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCheck,
  ClipboardPaste,
  HelpCircle,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { type Lookups, useLookups } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { sourceLabel } from "@/components/labels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { inboxDetail, type ProposalView, type ThreadMessage } from "@/services/inbox/queries";
import type { Source } from "@/services/intake";
import type { MessagePart } from "@/services/intake/thread";
import { describePayload } from "@/services/proposals/schema";
import { Composer, type ComposerMessage } from "./composer";
import { ProposalCard } from "./proposal-card";
import { useDecisions, useReply } from "./use-inbox";

function PastedText({ text, source }: { text: string; source: string | null }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 400 || text.split("\n").length > 6;
  return (
    <blockquote className="flex flex-col gap-1 border-l-2 pl-2 text-muted-foreground">
      <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide">
        <ClipboardPaste className="size-3" />
        Pasted
        {source && source !== "typed" ? ` · ${sourceLabel(source)}` : ""}
      </span>
      <p className={cn("whitespace-pre-wrap", long && !open && "line-clamp-6")}>{text}</p>
      {long && (
        <button
          type="button"
          className="self-start text-xs underline"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </blockquote>
  );
}

function UserBubble({
  parts,
  source,
  answer,
  pending = false,
}: {
  parts: MessagePart[];
  source: string | null;
  answer?: boolean;
  pending?: boolean;
}) {
  return (
    <div
      className={cn(
        "ml-auto flex max-w-[85%] flex-col gap-2 rounded-lg bg-muted px-3 py-2 text-sm",
        pending && "opacity-60",
      )}
    >
      {answer && <span className="text-xs text-muted-foreground">Answer</span>}
      {parts.map((p, i) =>
        p.type === "pasted" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
          <PastedText key={i} text={p.text} source={source} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
          <p key={i} className="whitespace-pre-wrap">
            {p.text}
          </p>
        ),
      )}
    </div>
  );
}

function QuestionCard({ proposal, answering }: { proposal: ProposalView; answering: boolean }) {
  const { reject } = useDecisions();
  const question = proposal.payload.kind === "needs_clarification" ? proposal.payload.question : "";
  const answer = (proposal.result as { answer?: string } | null)?.answer;
  const pending = proposal.status === "pending";
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-sm",
        pending ? "border-amber-500/40 bg-amber-500/5" : "border-dashed text-muted-foreground",
      )}
    >
      <p className="font-medium">
        <HelpCircle className="mr-1 inline size-4 text-amber-600" />
        {question}
      </p>
      {answer && <p>You answered: {answer}</p>}
      {pending && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{answering ? "Your next message answers this." : "Reply below to answer."}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6"
            onClick={() => reject.mutate(proposal.id)}
          >
            Skip
          </Button>
        </div>
      )}
    </div>
  );
}

function AssistantTurn({
  summary,
  proposals,
  lookups,
  answeringId,
}: {
  summary: string | null;
  proposals: ProposalView[];
  lookups: Lookups;
  answeringId: string | null;
}) {
  const shown = proposals.filter((p) => p.status !== "superseded");
  const replaced = proposals.filter((p) => p.status === "superseded");
  return (
    <div className="flex max-w-[95%] flex-col gap-2">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Sparkles className="size-3.5 shrink-0" />
        {summary ?? (shown.length ? "Here is what I propose." : "Nothing to do here.")}
      </p>
      {shown.map((p) =>
        p.kind === "needs_clarification" ? (
          <QuestionCard key={p.id} proposal={p} answering={p.id === answeringId} />
        ) : (
          <ProposalCard key={p.id} proposal={p} lookups={lookups} />
        ),
      )}
      {replaced.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{replaced.length} replaced by a later reply</summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-4">
            {replaced.map((p) => (
              <li key={p.id} className="line-through">
                {describePayload(p.payload)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ThreadView({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: queryKeys.inboxDetail(id),
    queryFn: ({ signal }) => run(inboxDetail(id), signal),
  });
  const lookups = useLookups();
  const { approveAll, dismiss, retriage } = useDecisions();
  const reply = useReply();
  const [skipAnswer, setSkipAnswer] = useState<string | null>(null);
  const d = detail.data;
  if (detail.isPending) return <Loader2 className="m-6 animate-spin text-muted-foreground" />;
  if (!d) return <p className="p-6 text-sm text-muted-foreground">This thread no longer exists.</p>;

  const pendingActions = d.proposals.filter(
    (p) => p.status === "pending" && p.kind !== "needs_clarification",
  ).length;
  const byMessage = new Map<string | null, ProposalView[]>();
  for (const p of d.proposals)
    byMessage.set(p.messageId, [...(byMessage.get(p.messageId) ?? []), p]);
  // The newest open question is what a reply answers, unless the user opts out.
  const openQuestion = d.proposals
    .filter((p) => p.kind === "needs_clarification" && p.status === "pending")
    .at(-1);
  const answering = openQuestion && openQuestion.id !== skipAnswer ? openQuestion : null;
  const last = d.messages.at(-1);
  const unanswered = !reply.isPending && last?.role === "user" && d.item.error;

  const send = (m: ComposerMessage) =>
    reply.mutate({
      inboxItemId: id,
      text: m.pasted.join("\n\n"),
      instruction: m.typed || null,
      source: m.pasted.length ? m.source : undefined,
      // Only a typed reply answers; pasted text starts new items instead.
      answers: answering && m.typed && m.pasted.length === 0 ? answering.id : null,
    });
  const sending = reply.isPending ? reply.variables : null;

  const turn = (m: ThreadMessage) =>
    m.role === "user" ? (
      <UserBubble key={m.id} parts={m.parts} source={m.source} answer={!!m.answers} />
    ) : (
      <AssistantTurn
        key={m.id}
        summary={m.summary}
        proposals={byMessage.get(m.id) ?? []}
        lookups={lookups}
        answeringId={answering?.id ?? null}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{sourceLabel(d.item.source)}</Badge>
          {d.item.senderName && <span>from {d.item.senderName}</span>}
          <span title={dateTime(d.item.receivedAt)}>{relativeTime(d.item.receivedAt)}</span>
          <Badge variant="secondary">{d.item.status}</Badge>
        </div>
        <h2 className="text-lg font-semibold">{d.item.summary ?? "Reading..."}</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pendingActions === 0 || approveAll.isPending}
            onClick={() => approveAll.mutate(id)}
          >
            {approveAll.isPending ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            Approve all ({pendingActions})
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={retriage.isPending || reply.isPending}
            onClick={() => retriage.mutate(id)}
          >
            {retriage.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Re-triage
          </Button>
          {d.item.status !== "dismissed" && (
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(id)}>
              <Trash2 /> Dismiss
            </Button>
          )}
        </div>
      </header>
      <Conversation className="min-h-0 flex-1 rounded-lg border">
        <ConversationContent className="gap-4 p-4">
          {d.messages.map(turn)}
          {/* Proposals made before threads existed have no turn of their own. */}
          {(byMessage.get(null) ?? []).length > 0 && (
            <AssistantTurn
              summary={d.item.summary}
              proposals={byMessage.get(null) ?? []}
              lookups={lookups}
              answeringId={answering?.id ?? null}
            />
          )}
          {sending && (
            <>
              <UserBubble
                pending
                source={sending.source ?? null}
                answer={!!sending.answers}
                parts={[
                  ...(sending.text ? [{ type: "pasted" as const, text: sending.text }] : []),
                  ...(sending.instruction
                    ? [{ type: "typed" as const, text: sending.instruction }]
                    : []),
                ]}
              />
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {reply.progress ?? "Working..."}
              </p>
            </>
          )}
          {unanswered && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>That message did not go through</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>{d.item.error}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retriage.isPending}
                  onClick={() => retriage.mutate(id)}
                >
                  {retriage.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer
        busy={reply.isPending}
        progress={reply.progress}
        onCancel={reply.cancel}
        onSend={send}
        defaultSource={d.item.source as Source}
        placeholder={`Ask for a change ("priority High", "make it a sub-task of PAY-3"), answer a question, or paste more.`}
        banner={
          answering && (
            <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1 text-xs">
              <HelpCircle className="size-3.5 text-amber-600" />
              <span className="min-w-0 flex-1 truncate">
                Answering:{" "}
                {answering.payload.kind === "needs_clarification" && answering.payload.question}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                aria-label="Do not treat my next message as the answer"
                onClick={() => setSkipAnswer(answering.id)}
              >
                <X />
              </Button>
            </div>
          )
        }
      />
    </div>
  );
}

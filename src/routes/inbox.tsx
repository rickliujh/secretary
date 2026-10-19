import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArchiveRestore, MessagesSquare, Plus } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Composer, toTriageInput } from "@/components/inbox/composer";
import { AboutBadge, useParkActions, useParkInput } from "@/components/inbox/park";
import { SmallAsksHint } from "@/components/inbox/small-asks-hint";
import { ThreadView } from "@/components/inbox/thread-view";
import { useTriage } from "@/components/inbox/use-inbox";
import { EmptyState } from "@/components/page";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { type InboxListItem, listInbox } from "@/services/inbox/queries";

export const Route = createFileRoute("/inbox")({
  validateSearch: z.object({ item: z.string().optional() }),
  component: InboxPage,
});

/** Threads (design.md D22): a list on the left, one conversation on the right. */
function InboxPage() {
  const { item } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const [text, setText] = useState("");
  const search = useDeferredValue(text.trim());
  const against = useParkInput();
  const list = useQuery({
    queryKey: queryKeys.inboxList(search, against),
    queryFn: ({ signal }) => run(listInbox(search, { against }), signal),
  });
  const select = (id: string | undefined) => navigate({ search: { item: id } });
  const { bringBack } = useParkActions();
  // Parked threads have a section of their own at the bottom (D62).
  const open = (list.data ?? []).filter((i) => i.status !== "parked");
  const parked = (list.data ?? []).filter((i) => i.status === "parked");
  const row = (i: InboxListItem) => (
    <button
      type="button"
      onClick={() => select(i.id)}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-muted",
        i.id === item && "bg-muted",
        i.status === "dismissed" && "opacity-60",
      )}
    >
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{relativeTime(i.receivedAt)}</span>
        {i.senderName && <span>· {i.senderName}</span>}
        <span className="ml-auto flex gap-1">
          {i.pending > 0 && <Badge className="h-4 px-1.5">{i.pending}</Badge>}
          {i.failed > 0 && (
            <Badge variant="destructive" className="h-4 px-1.5">
              {i.failed}
            </Badge>
          )}
          {i.error && (
            <Badge variant="destructive" className="h-4 px-1.5">
              error
            </Badge>
          )}
        </span>
      </span>
      <span className="line-clamp-1 text-sm font-medium">{i.summary ?? i.preview}</span>
      {i.summary && <span className="line-clamp-1 text-xs text-muted-foreground">{i.preview}</span>}
      {(i.returned || (i.about && i.status !== "parked")) && (
        <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {i.returned && <span className="truncate">Back: {i.parkedReason}</span>}
          <AboutBadge about={i.status === "parked" ? null : i.about} />
        </span>
      )}
      {i.status === "parked" && (
        <span className="line-clamp-1 text-xs text-muted-foreground">Parked {i.parkedReason}</span>
      )}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 gap-6">
      <aside className="flex w-80 shrink-0 flex-col gap-3">
        <Button variant={item ? "outline" : "secondary"} onClick={() => select(undefined)}>
          <Plus /> New thread
        </Button>
        <SearchInput
          aria-label="Search threads"
          placeholder="Search threads"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {open.map((i) => (
            <li key={i.id}>{row(i)}</li>
          ))}
          {parked.length > 0 && (
            <li className="mt-3 border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
              Parked ({parked.length})
            </li>
          )}
          {parked.map((i) => (
            <li key={i.id} className="flex items-start gap-1">
              <div className="min-w-0 flex-1 opacity-80">{row(i)}</div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 h-7 shrink-0 px-2 text-xs"
                disabled={bringBack.isPending}
                onClick={() => bringBack.mutate(i.id)}
              >
                <ArchiveRestore /> Bring back
              </Button>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {search ? "No matches." : "No threads yet."}
            </li>
          )}
        </ul>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {item ? <ThreadView key={item} id={item} /> : <NewThread onStarted={select} />}
      </section>
    </div>
  );
}

function NewThread({ onStarted }: { onStarted: (id: string) => void }) {
  const triage = useTriage(onStarted);
  return (
    <div className="flex h-full flex-col justify-end gap-6">
      <SmallAsksHint />
      <EmptyState
        className="border-0"
        icon={MessagesSquare}
        title="Start a thread"
        description="Paste a Teams message, an email or meeting notes and say what you want done. The secretary proposes Jira actions; ask for changes in the thread, then approve."
      />
      <Composer
        withSender
        busy={triage.isPending}
        progress={triage.progress}
        onCancel={triage.cancel}
        onSend={(m) => triage.mutate(toTriageInput(m))}
      />
    </div>
  );
}

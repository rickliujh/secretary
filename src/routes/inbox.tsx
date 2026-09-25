import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MessagesSquare, Plus, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Composer, toTriageInput } from "@/components/inbox/composer";
import { ThreadView } from "@/components/inbox/thread-view";
import { useTriage } from "@/components/inbox/use-inbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { listInbox } from "@/services/inbox/queries";

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
  const list = useQuery({
    queryKey: queryKeys.inboxList(search),
    queryFn: ({ signal }) => run(listInbox(search), signal),
  });
  const select = (id: string | undefined) => navigate({ search: { item: id } });

  return (
    <div className="flex h-full min-h-0 gap-6">
      <aside className="flex w-80 shrink-0 flex-col gap-3">
        <Button variant={item ? "outline" : "secondary"} onClick={() => select(undefined)}>
          <Plus /> New thread
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search threads"
            placeholder="Search threads"
            className="pl-8"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {(list.data ?? []).map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => select(i.id)}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-muted",
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
                {i.summary && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">{i.preview}</span>
                )}
              </button>
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
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <MessagesSquare className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Start a thread</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Paste a Teams message, an email or meeting notes and say what you want done. The secretary
          proposes Jira actions; ask for changes in the thread, then approve.
        </p>
      </div>
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

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Inbox, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { InboxDetail } from "@/components/inbox/inbox-detail";
import { IntakeBox } from "@/components/inbox/intake-box";
import { Planned } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { listInbox } from "@/services/inbox/queries";

export const Route = createFileRoute("/inbox")({
  validateSearch: z.object({ item: z.string().optional() }),
  component: InboxPage,
});

function InboxPage() {
  const { item } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const [text, setText] = useState("");
  const search = useDeferredValue(text.trim());
  const list = useQuery({
    queryKey: queryKeys.inboxList(search),
    queryFn: ({ signal }) => run(listInbox(search), signal),
  });
  const select = (id: string) => navigate({ search: { item: id } });
  const selected = item ?? list.data?.[0]?.id;

  return (
    <div className="flex h-full gap-6">
      <aside className="flex w-96 shrink-0 flex-col gap-3">
        <IntakeBox onTriaged={select} />
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search inbox"
            placeholder="Search history"
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
                  i.id === selected && "bg-muted",
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
              {search ? "No matches." : "Nothing yet."}
            </li>
          )}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <InboxDetail id={selected} onSelect={select} />
        ) : (
          <Planned
            icon={Inbox}
            title="Paste something to start"
            description="Teams messages, emails and meeting notes become proposed Jira actions that you approve one by one or all at once."
          />
        )}
      </section>
    </div>
  );
}

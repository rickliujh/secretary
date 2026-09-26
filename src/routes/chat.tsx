import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { ChatThread } from "@/components/chat/chat-thread";
import { forgetChat, lastChat } from "@/components/chat/store";
import { Button } from "@/components/ui/button";
import { newId } from "@/lib/ids";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { deleteConversation, listConversations } from "@/services/chat/history";

export const Route = createFileRoute("/chat")({
  validateSearch: z.object({ c: z.string().optional() }),
  component: ChatPage,
});

/** Ask the secretary (FR-8, D25) with saved conversations (D28). */
function ChatPage() {
  const { c } = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const onError = useErrorToast();
  const list = useQuery({
    queryKey: queryKeys.chats,
    queryFn: ({ signal }) => run(listConversations, signal),
  });
  // A new conversation gets an id now and is saved with its first answer.
  const [fresh] = useState(newId);
  const id = c ?? lastChat() ?? (list.isSuccess ? (list.data[0]?.id ?? fresh) : null);
  const open = (next: string) => navigate({ search: { c: next } });

  const remove = useMutation({
    mutationFn: (target: string) => run(deleteConversation(target)),
    onSuccess: (_r, target) => {
      forgetChat(target);
      void client.invalidateQueries({ queryKey: queryKeys.chats });
      if (target === id) open(newId());
    },
    onError: (e) => onError(e),
  });

  return (
    <div className="flex h-full min-h-0 gap-6">
      <aside className="flex w-72 shrink-0 flex-col gap-3">
        <Button variant="outline" onClick={() => open(newId())}>
          <Plus /> New chat
        </Button>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {(list.data ?? []).map((conv) => (
            <li key={conv.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => open(conv.id)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted",
                  conv.id === id && "bg-muted",
                )}
              >
                <span className="line-clamp-2 text-sm">{conv.title}</span>
                <span className="text-xs text-muted-foreground">
                  {relativeTime(conv.updatedAt)}
                </span>
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Delete "${conv.title}"`}
                onClick={() => remove.mutate(conv.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              Past conversations appear here.
            </li>
          )}
        </ul>
      </aside>
      <section className="mx-auto flex min-h-0 min-w-0 max-w-3xl flex-1 flex-col">
        {id && <ChatThread key={id} id={id} />}
      </section>
    </div>
  );
}

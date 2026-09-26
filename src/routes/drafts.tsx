import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { DraftComposer } from "@/components/drafts/draft-composer";
import { DraftEditor } from "@/components/drafts/draft-editor";
import { CHANNEL_LABELS, intentLabel } from "@/components/labels";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { type DraftListItem, listDrafts } from "@/services/comms/queries";

export const Route = createFileRoute("/drafts")({
  validateSearch: z.object({
    id: z.string().optional(),
    /** Write the draft as soon as it opens (composer, "Draft a chase"). */
    write: z.boolean().optional(),
  }),
  component: DraftsPage,
});

const STATUS_TONE: Record<DraftListItem["status"], string> = {
  draft: "",
  copied: TONE.info,
  sent: TONE.success,
};

/** Drafts (FR-6): Teams messages and emails in each recipient's style. */
function DraftsPage() {
  const { id, write } = Route.useSearch();
  const navigate = useNavigate({ from: "/drafts" });
  const list = useQuery({
    queryKey: queryKeys.draftList,
    queryFn: ({ signal }) => run(listDrafts, signal),
  });

  return (
    <div className="flex h-full min-h-0 gap-6">
      <aside className="flex w-80 shrink-0 flex-col gap-3">
        <Button variant={id ? "outline" : "secondary"} onClick={() => navigate({ search: {} })}>
          <Plus /> New draft
        </Button>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {(list.data ?? []).map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => navigate({ search: { id: d.id } })}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-muted",
                  d.id === id && "bg-muted",
                  d.status === "sent" && "opacity-70",
                )}
              >
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{relativeTime(d.sentAt ?? d.createdAt)}</span>
                  <span>· {CHANNEL_LABELS[d.kind]}</span>
                  <Badge
                    variant="secondary"
                    className={cn("ml-auto h-4 border-transparent px-1.5", STATUS_TONE[d.status])}
                  >
                    {d.generated || d.status !== "draft" ? d.status : "not written"}
                  </Badge>
                </span>
                <span className="line-clamp-1 text-sm font-medium">
                  {intentLabel(d.intent)} to {d.recipient ?? "someone"}
                </span>
                {d.preview && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">{d.preview}</span>
                )}
              </button>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No drafts yet.</li>
          )}
        </ul>
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {id ? (
          <DraftEditor
            key={id}
            id={id}
            write={!!write}
            onDeleted={() => navigate({ search: {} })}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">New draft</h2>
              <p className="text-sm text-muted-foreground">
                The secretary writes a short and a standard version in the recipient's style,
                grounded in the tickets and what you are waiting on. You copy it and send it
                yourself.
              </p>
            </div>
            <DraftComposer />
          </div>
        )}
      </section>
    </div>
  );
}

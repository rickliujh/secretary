import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { Brain, Check, Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { MemoryDialog } from "@/components/memory/memory-dialog";
import { useMemoryMutation } from "@/components/memory/use-memory";
import { PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Learning } from "@/services/learning";
import {
  deleteMemory,
  listMemories,
  type MemoryView,
  setConfirmed,
  setWeight,
  WEIGHTS,
} from "@/services/memory/queries";

export const Route = createFileRoute("/memory")({
  validateSearch: z.object({ tab: z.enum(["memories", "corrections"]).optional() }),
  component: MemoryPage,
});

/** FR-7: what the secretary remembers, where it came from and how often it helps. */
function MemoryPage() {
  const { tab = "memories" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const navigateTo = useNavigate();
  const list = useQuery({
    queryKey: queryKeys.memories,
    queryFn: ({ signal }) => run(listMemories, signal),
  });
  const [editing, setEditing] = useState<MemoryView | null | undefined>(undefined);
  const consolidate = useAppMutation(() => Effect.flatMap(Learning, (l) => l.consolidate), {
    onSuccess: (r) => {
      if (r.inboxItemId) {
        toast.success(`${r.rules} rule${r.rules === 1 ? "" : "s"} to review`);
        void navigateTo({ to: "/inbox", search: { item: r.inboxItemId } });
      } else toast.info(`No clear pattern in ${r.corrections} corrections yet.`);
    },
  });
  const all = list.data ?? [];
  const kept = all.filter((m) => m.kind !== "example");
  const corrections = all.filter((m) => m.kind === "example");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Memory"
        description="Rules, facts and preferences the secretary follows, and the corrections it learns from."
      />
      <Tabs value={tab} onValueChange={(t) => navigate({ search: { tab: t as typeof tab } })}>
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="memories">Rules and preferences ({kept.length})</TabsTrigger>
            <TabsTrigger value="corrections">Corrections ({corrections.length})</TabsTrigger>
          </TabsList>
          <Button className="ml-auto" onClick={() => setEditing(null)}>
            <Plus /> Add memory
          </Button>
        </div>
        <TabsContent value="memories" className="mt-4 flex flex-col gap-2">
          {kept.map((m) => (
            <MemoryCard key={m.id} memory={m} onEdit={() => setEditing(m)} />
          ))}
          {list.isSuccess && kept.length === 0 && (
            <Empty>
              Nothing yet. Add a rule such as “anything about the billing migration goes under
              PAY-1”, or approve a “remember” proposal in the Inbox.
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="corrections" className="mt-4 flex flex-col gap-2">
          {corrections.length >= 2 && (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="flex-1 text-muted-foreground">
                Look for patterns in these corrections and suggest rules. Suggestions arrive in the
                Inbox for you to approve; nothing is remembered until you do.
              </p>
              <Button disabled={consolidate.isPending} onClick={() => consolidate.mutate()}>
                {consolidate.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Suggest rules
              </Button>
            </div>
          )}
          {corrections.map((m) => (
            <CorrectionCard key={m.id} memory={m} />
          ))}
          {list.isSuccess && corrections.length === 0 && (
            <Empty>
              When you edit, reject or ask for a change to a proposal, the change is kept here and
              shown to the model next time something similar comes in.
            </Empty>
          )}
        </TabsContent>
      </Tabs>
      <MemoryDialog
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        memory={editing}
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      <Brain className="size-6" />
      <p className="max-w-md">{children}</p>
    </div>
  );
}

function Provenance({ m }: { m: MemoryView }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span>
        {m.source === "user" ? "Added by you" : "Inferred"} {relativeTime(m.createdAt)}
      </span>
      {m.sourceInboxItemId && (
        <Link to="/inbox" search={{ item: m.sourceInboxItemId }} className="underline">
          from a thread
        </Link>
      )}
      <span>
        {m.useCount
          ? `used ${m.useCount} time${m.useCount === 1 ? "" : "s"}, last ${relativeTime(m.lastUsedAt ?? m.createdAt)}`
          : "not used yet"}
      </span>
    </span>
  );
}

function MemoryCard({ memory: m, onEdit }: { memory: MemoryView; onEdit: () => void }) {
  const weight = useMemoryMutation((w: number) => setWeight(m.id, w));
  const confirm = useMemoryMutation(() => setConfirmed(m.id, true), "Confirmed");
  const remove = useMemoryMutation(() => deleteMemory(m.id), "Forgotten");
  const preset = Object.entries(WEIGHTS).find(([, w]) => w === m.weight)?.[0] ?? "normal";
  return (
    <article
      className={cn("flex flex-col gap-2 rounded-lg border p-3", !m.confirmed && "border-dashed")}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="capitalize">
          {m.kind}
        </Badge>
        {m.subjectLabel && <Badge variant="outline">about {m.subjectLabel}</Badge>}
        {!m.confirmed && <Badge variant="outline">not confirmed, not used</Badge>}
        <span className="ml-auto flex items-center gap-1">
          <Select
            value={preset}
            onValueChange={(v) => weight.mutate(WEIGHTS[v as keyof typeof WEIGHTS])}
          >
            <SelectTrigger size="sm" className="w-28" aria-label="Importance">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
          <Button size="icon" variant="ghost" aria-label="Edit" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete"
            onClick={() => remove.mutate(undefined)}
          >
            <Trash2 />
          </Button>
        </span>
      </header>
      <p className="text-sm whitespace-pre-wrap">{m.content}</p>
      <div className="flex items-center gap-2">
        <Provenance m={m} />
        {!m.confirmed && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => confirm.mutate(undefined)}
          >
            <Check /> Confirm
          </Button>
        )}
      </div>
    </article>
  );
}

function CorrectionCard({ memory: m }: { memory: MemoryView }) {
  const remove = useMemoryMutation(() => deleteMemory(m.id), "Correction removed");
  return (
    <article className="flex flex-col gap-2 rounded-lg border p-3">
      <header className="flex items-center gap-2">
        {m.subjectLabel && <Badge variant="secondary">{m.subjectLabel}</Badge>}
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto"
          aria-label="Remove correction"
          onClick={() => remove.mutate(undefined)}
        >
          <Trash2 />
        </Button>
      </header>
      {m.example?.input && (
        <blockquote className="line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {m.example.input}
        </blockquote>
      )}
      <p className="text-sm">
        <span className="text-muted-foreground">Proposed: </span>
        {m.example?.before || "(unknown)"}
      </p>
      <p className="text-sm">
        <span className="text-muted-foreground">
          {m.example?.after === null ? "You rejected it." : "You changed it to: "}
        </span>
        {m.example?.after}
      </p>
      <Provenance m={m} />
    </article>
  );
}

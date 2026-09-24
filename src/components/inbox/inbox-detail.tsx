import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateTime } from "@/lib/time";
import { inboxDetail } from "@/services/inbox/queries";
import type { Source } from "@/services/intake";
import { ClarificationCard } from "./clarification-card";
import { ProposalCard } from "./proposal-card";
import { useDecisions, useLookups } from "./use-inbox";

export function InboxDetail({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  const detail = useQuery({
    queryKey: queryKeys.inboxDetail(id),
    queryFn: ({ signal }) => run(inboxDetail(id), signal),
  });
  const lookups = useLookups();
  const { approveAll, dismiss, retriage } = useDecisions();
  const d = detail.data;
  if (detail.isPending) return <Loader2 className="m-6 animate-spin text-muted-foreground" />;
  if (!d)
    return <p className="p-6 text-sm text-muted-foreground">This inbox item no longer exists.</p>;

  const pendingActions = d.proposals.filter(
    (p) => p.status === "pending" && p.kind !== "needs_clarification",
  ).length;
  const byItem = new Map<string | null, typeof d.proposals>();
  for (const p of d.proposals)
    byItem.set(p.intakeItemId, [...(byItem.get(p.intakeItemId) ?? []), p]);
  const loose = byItem.get(null) ?? [];

  const card = (p: (typeof d.proposals)[number]) =>
    p.kind === "needs_clarification" ? (
      <ClarificationCard
        key={p.id}
        proposal={p}
        rawText={d.item.rawText}
        source={d.item.source as Source}
        senderPersonId={d.item.senderPersonId}
        onTriaged={onSelect}
      />
    ) : (
      <ProposalCard key={p.id} proposal={p} lookups={lookups} />
    );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{d.item.source}</Badge>
          {d.item.senderName && <span>from {d.item.senderName}</span>}
          <span>{dateTime(d.item.receivedAt)}</span>
          <Badge variant="secondary">{d.item.status}</Badge>
        </div>
        <h2 className="text-lg font-semibold">{d.item.summary ?? "Not triaged yet"}</h2>
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
            disabled={retriage.isPending}
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
      {d.item.error && (
        <Alert variant="destructive">
          <AlertTitle>Triage did not finish</AlertTitle>
          <AlertDescription>
            {d.item.error} Fix the cause (often the model settings), then re-triage.
          </AlertDescription>
        </Alert>
      )}
      <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Original input</summary>
        <pre className="mt-2 font-sans whitespace-pre-wrap">{d.item.rawText}</pre>
      </details>
      {d.items.map((item) => (
        <section key={item.id} className="flex flex-col gap-2">
          {d.items.length > 1 && (
            <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
              {item.quote}
            </blockquote>
          )}
          {item.error && (
            <p className="text-xs text-destructive">This item could not be classified reliably.</p>
          )}
          {(byItem.get(item.id) ?? []).map(card)}
          {item.model && (
            <p className="text-right text-xs text-muted-foreground">
              {item.tier} · {item.model}
              {item.escalated && " · escalated"}
            </p>
          )}
        </section>
      ))}
      {loose.length > 0 && <section className="flex flex-col gap-2">{loose.map(card)}</section>}
      {d.proposals.length === 0 && d.item.status === "triaged" && (
        <p className="text-sm text-muted-foreground">Nothing actionable was found in this input.</p>
      )}
    </div>
  );
}

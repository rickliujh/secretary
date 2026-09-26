import { Link } from "@tanstack/react-router";
import { Check, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Lookups } from "@/app/queries";
import { CHANNEL_LABELS, INTENT_LABELS } from "@/components/labels";
import { Markdown } from "@/components/markdown";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProposalView } from "@/services/inbox/queries";
import { NEW_REF_RE, PROPOSAL_LABELS, type ProposalPayload } from "@/services/proposals/schema";
import { ProposalEditDialog } from "./proposal-edit-dialog";
import { useDecisions } from "./use-inbox";

const STATUS_TONE: Record<string, string> = {
  pending: TONE.warning,
  executed: TONE.success,
  failed: TONE.danger,
  rejected: TONE.neutral,
  approved: TONE.info,
};

function IssueRef({ value, lookups }: { value: string; lookups: Lookups }) {
  if (NEW_REF_RE.test(value)) return <Badge variant="outline">new issue {value.slice(5)}</Badge>;
  const issue = lookups.issue.get(value);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Link to="/tickets" search={{ key: value }} className="font-mono text-xs underline">
        {value}
      </Link>
      {issue && <span className="truncate text-muted-foreground">{issue.summary}</span>}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Kind-specific view of the concrete payload (FR-2.3). */
function PayloadView({ p, lookups }: { p: ProposalPayload; lookups: Lookups }) {
  const person = (id: string | null) => (id ? (lookups.person.get(id)?.displayName ?? id) : null);
  const team = (id: string | null) => (id ? (lookups.team.get(id)?.name ?? id) : null);
  switch (p.kind) {
    case "create_issue":
      return (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
          <Row label="Summary">
            <span className="font-medium">{p.summary}</span>
          </Row>
          <Row label="Where">
            {p.issueType} in {p.projectKey}
          </Row>
          <Row label="Epic">{p.epic && <IssueRef value={p.epic} lookups={lookups} />}</Row>
          <Row label="Parent">{p.parent && <IssueRef value={p.parent} lookups={lookups} />}</Row>
          <Row label="Priority">{p.priority}</Row>
          <Row label="Assignee">{p.assignee}</Row>
          <Row label="Due">{p.dueDate}</Row>
          <Row label="Description">{p.descriptionMd && <Markdown>{p.descriptionMd}</Markdown>}</Row>
        </dl>
      );
    case "update_issue":
      return (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
          <Row label="Issue">
            <IssueRef value={p.target} lookups={lookups} />
          </Row>
          <Row label="Summary">{p.changes.summary}</Row>
          <Row label="Priority">{p.changes.priority}</Row>
          <Row label="Due">{p.changes.dueDate === null ? "clear" : p.changes.dueDate}</Row>
          <Row label="Assignee">
            {p.changes.assignee === null ? "unassign" : p.changes.assignee}
          </Row>
        </dl>
      );
    case "add_comment":
      return (
        <div className="flex flex-col gap-1 text-sm">
          <IssueRef value={p.target} lookups={lookups} />
          <div className="rounded-md border bg-muted/40 px-3 py-2">
            <Markdown>{p.bodyMd}</Markdown>
          </div>
        </div>
      );
    case "transition_issue":
      return (
        <p className="flex items-center gap-2 text-sm">
          <IssueRef value={p.target} lookups={lookups} />
          <span className="text-muted-foreground">→</span>
          <Badge variant="secondary">{p.toStatus}</Badge>
        </p>
      );
    case "link_dependency":
      return (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
          <Row label="Issue">
            <IssueRef value={p.target} lookups={lookups} />
          </Row>
          <Row label="Waits on">
            {p.label} <Badge variant="outline">{p.dependencyKind}</Badge>
          </Row>
          <Row label="Owner">{person(p.ownerPersonId) ?? team(p.ownerTeamId)}</Row>
          <Row label="Reference">
            {p.externalRef && <span className="font-mono text-xs">{p.externalRef}</span>}
          </Row>
          <Row label="Expected">{p.expectedAt}</Row>
          <Row label="Follow up">{p.nextFollowupAt}</Row>
        </dl>
      );
    case "update_person":
    case "update_team": {
      const changes = Object.entries(p.changes).flatMap(([k, v]) =>
        v && typeof v === "object"
          ? Object.entries(v).map(([k2, v2]) => [k2, String(v2)])
          : [[k, String(v)]],
      );
      return (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
          <Row label={p.kind === "update_person" ? "Contact" : "Team"}>
            {p.kind === "update_person" ? person(p.personId) : team(p.teamId)}
          </Row>
          {changes.map(([k, v]) => (
            <Row key={k} label={k ?? ""}>
              {v}
            </Row>
          ))}
          <Row label="Add note">{p.noteAppend}</Row>
        </dl>
      );
    }
    case "remember":
      return (
        <p className="text-sm">
          <Badge variant="outline" className="mr-2">
            {p.memoryKind}
          </Badge>
          {p.content}
        </p>
      );
    case "draft_message":
      return (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
          <Row label="To">{person(p.recipientPersonId) ?? team(p.recipientTeamId)}</Row>
          <Row label="What">
            {INTENT_LABELS[p.intent]} via {CHANNEL_LABELS[p.channel]}
          </Row>
          <Row label="About">
            {p.issueKeys.length > 0 && (
              <span className="flex flex-wrap gap-2">
                {p.issueKeys.map((k) => (
                  <IssueRef key={k} value={k} lookups={lookups} />
                ))}
              </span>
            )}
          </Row>
          <Row label="Say">{p.notes}</Row>
        </dl>
      );
    case "needs_clarification":
      return <p className="text-sm">{p.question}</p>;
  }
}

function Confidence({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        value < 0.6 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
      )}
      title="How sure the secretary is"
    >
      {value < 0.6 ? `low confidence ${pct}%` : `${pct}%`}
    </span>
  );
}

export function ProposalCard({ proposal, lookups }: { proposal: ProposalView; lookups: Lookups }) {
  const { approve, reject } = useDecisions();
  const [editing, setEditing] = useState(false);
  const payload = proposal.editedPayload ?? proposal.payload;
  const result = proposal.result as {
    message?: string;
    error?: string;
    issueKey?: string;
    communicationId?: string;
  } | null;
  const pending = proposal.status === "pending";
  const busy = approve.isPending || reject.isPending;
  const canApprove = pending || proposal.status === "failed";

  return (
    <article
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card takes a/e/r shortcuts when focused (NFR-6).
      tabIndex={0}
      aria-label={`${PROPOSAL_LABELS[proposal.payload.kind]} proposal, ${proposal.status}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !pending && proposal.status !== "failed" && "opacity-75",
      )}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || busy) return;
        if (e.key === "a" && canApprove) approve.mutate({ id: proposal.id });
        if (e.key === "r" && pending) reject.mutate(proposal.id);
        if (e.key === "e" && canApprove) setEditing(true);
      }}
    >
      <header className="flex items-center gap-2">
        <Badge variant="secondary">{PROPOSAL_LABELS[proposal.payload.kind]}</Badge>
        <Badge
          variant="secondary"
          className={cn("border-transparent", STATUS_TONE[proposal.status])}
        >
          {proposal.status}
        </Badge>
        {proposal.editedPayload && <Badge variant="outline">edited</Badge>}
        <span className="ml-auto" />
        <Confidence value={proposal.confidence} />
      </header>
      <PayloadView p={payload} lookups={lookups} />
      {proposal.rationale && <p className="text-xs text-muted-foreground">{proposal.rationale}</p>}
      {proposal.evidence && (
        <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground italic">
          “{proposal.evidence}”
        </blockquote>
      )}
      {proposal.status === "executed" && result?.message && (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          {result.message}
          {result.issueKey && (
            <>
              {" "}
              <Link to="/tickets" search={{ key: result.issueKey }} className="underline">
                open
              </Link>
            </>
          )}
          {result.communicationId && (
            <>
              {" "}
              <Link
                to="/drafts"
                search={{ id: result.communicationId, write: true }}
                className="underline"
              >
                write it now
              </Link>
            </>
          )}
        </p>
      )}
      {proposal.status === "failed" && result?.error && (
        <p className="text-sm text-destructive">{result.error}</p>
      )}
      {canApprove && (
        <footer className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => approve.mutate({ id: proposal.id })}>
            {approve.isPending ? (
              <Loader2 className="animate-spin" />
            ) : proposal.status === "failed" ? (
              <RotateCcw />
            ) : (
              <Check />
            )}
            {proposal.status === "failed" ? "Retry" : "Approve"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          {pending && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => reject.mutate(proposal.id)}
            >
              <X /> Reject
            </Button>
          )}
        </footer>
      )}
      <ProposalEditDialog
        payload={payload}
        lookups={lookups}
        open={editing}
        onOpenChange={setEditing}
        onApprove={(edited) => approve.mutate({ id: proposal.id, edited })}
      />
    </article>
  );
}

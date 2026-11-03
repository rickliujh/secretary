/**
 * An outcome card (FR-19.6, D61, Phase 25): a fact changed, and these are the
 * follow-ups that set the rest right. Each step can be left out; one Approve
 * runs the rest in order through the Executor (`Proposals.approveBundle`).
 * A step the others hang on greys them out while it is off. Each step opens to
 * its proposal card, where it can be edited before approving.
 */
import { Check, CheckCheck, ChevronDown, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { type Lookups, useLookups } from "@/app/queries";
import { TicketLink } from "@/components/tickets/ticket-link";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { dateTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { InboxDetail, ProposalView } from "@/services/inbox/queries";
import { PROPOSAL_LABELS } from "@/services/proposals/schema";
import { RULE_LABELS } from "@/services/work/rules";
import { situationOf } from "@/services/work/schema";
import { ProposalCard } from "./proposal-card";
import { useDecisions } from "./use-inbox";

const STATUS_TONE: Record<string, string> = {
  executed: TONE.success,
  failed: TONE.danger,
  rejected: TONE.neutral,
  approved: TONE.info,
  revoked: TONE.neutral,
};

const STATUS_TEXT: Record<string, string> = {
  executed: "done",
  failed: "failed",
  rejected: "left out",
  approved: "running",
  revoked: "revoked",
};

function Step({
  proposal,
  label,
  required,
  checked,
  greyed,
  onCheckedChange,
  lookups,
}: {
  proposal: ProposalView;
  label: string;
  required: boolean;
  checked: boolean;
  /** Hangs on a required step that is off. */
  greyed: boolean;
  onCheckedChange: (on: boolean) => void;
  lookups: Lookups;
}) {
  const [open, setOpen] = useState(false);
  const { approve } = useDecisions();
  const decidable = proposal.status === "pending" || proposal.status === "failed";
  const id = `step-${proposal.id}`;
  const error = (proposal.result as { error?: string } | null)?.error;
  return (
    <li className={cn("flex flex-col gap-2 py-2", greyed && "opacity-50")}>
      <div className="flex items-start gap-2">
        {decidable ? (
          <Checkbox
            id={id}
            className="mt-0.5"
            checked={checked}
            disabled={greyed}
            onCheckedChange={(c) => onCheckedChange(c === true)}
          />
        ) : (
          <span className="mt-0.5 size-4 shrink-0" />
        )}
        <Label htmlFor={id} className="min-w-0 flex-1 flex-col items-start gap-0.5 font-normal">
          <span className="text-sm">{label}</span>
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {PROPOSAL_LABELS[proposal.payload.kind]}
            {required && <Badge variant="outline">the rest hang on this</Badge>}
            {proposal.editedPayload && <Badge variant="outline">edited</Badge>}
          </span>
        </Label>
        {!["pending"].includes(proposal.status) && (
          <Badge
            variant="secondary"
            className={cn("border-transparent", STATUS_TONE[proposal.status])}
          >
            {STATUS_TEXT[proposal.status] ?? proposal.status}
          </Badge>
        )}
        {proposal.status === "failed" && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={approve.isPending}
            onClick={() => approve.mutate({ id: proposal.id })}
          >
            {approve.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Retry
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={open ? "Hide the step" : "Show and edit the step"}
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
        >
          <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      </div>
      {proposal.status === "failed" && error && !open && (
        <p className="ml-6 text-sm text-destructive">{error}</p>
      )}
      {open && (
        <div className="ml-6 border-l-2 pl-3">
          <ProposalCard proposal={proposal} lookups={lookups} inBundle />
        </div>
      )}
    </li>
  );
}

export function OutcomeCard({ detail }: { detail: InboxDetail }) {
  const lookups = useLookups();
  const { approveBundle, fileBundle, dismiss } = useDecisions();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const situation = situationOf(detail.item.triage);
  const steps = [...detail.proposals].sort((a, b) => a.seq - b.seq);
  const meta = new Map(situation?.steps.map((s) => [s.seq, s]) ?? []);
  const required = (p: ProposalView) => !!meta.get(p.seq)?.required;
  const decidable = steps.filter((p) => p.status === "pending" || p.status === "failed");
  const requiredOff = steps.some((p) => required(p) && p.status === "pending" && off.has(p.id));
  const greyed = (p: ProposalView) => requiredOff && !required(p);
  const kept = decidable.filter((p) => !off.has(p.id) && !greyed(p));
  const open = detail.item.status === "triaged";
  const failed = steps.some((p) => p.status === "failed");
  const busy = approveBundle.isPending || dismiss.isPending || fileBundle.isPending;
  const pendingLeft = steps.some((p) => p.status === "pending");
  const rule = situation ? RULE_LABELS[situation.rule] : null;
  const toggle = (id: string, on: boolean) =>
    setOff((s) => {
      const next = new Set(s);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">Secretary</Badge>
          {rule && <span>Because {rule.name}</span>}
          <span title={dateTime(detail.item.receivedAt)}>
            {relativeTime(detail.item.receivedAt)}
          </span>
          {!open && <Badge variant="secondary">{detail.item.status}</Badge>}
        </div>
        <h2 className="text-lg font-semibold">{situation?.title ?? detail.item.summary}</h2>
        {situation?.why && <p className="text-sm">{situation.why}</p>}
        {(situation?.itemName || (situation?.keys.length ?? 0) > 0) && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {situation?.itemName && <span>Work item: {situation.itemName}</span>}
            {situation?.keys.map((k) => (
              <TicketLink key={k} ticketKey={k} className="font-mono underline">
                {k}
              </TicketLink>
            ))}
          </p>
        )}
      </header>
      {steps.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border px-3">
          {steps.map((p) => (
            <Step
              key={p.id}
              proposal={p}
              label={meta.get(p.seq)?.label ?? p.rationale ?? PROPOSAL_LABELS[p.payload.kind]}
              required={required(p)}
              checked={!off.has(p.id) && !greyed(p)}
              greyed={greyed(p) && p.status === "pending"}
              onCheckedChange={(on) => toggle(p.id, on)}
              lookups={lookups}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing to change; this is a reminder to have a look.
        </p>
      )}
      {open && (
        <footer className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || (steps.length > 0 && kept.length === 0)}
            onClick={() =>
              approveBundle.mutate({ bundleId: detail.item.id, keep: kept.map((p) => p.id) })
            }
          >
            {approveBundle.isPending ? (
              <Loader2 className="animate-spin" />
            ) : failed ? (
              <RotateCcw />
            ) : (
              <Check />
            )}
            {steps.length === 0
              ? "Got it"
              : failed
                ? "Retry"
                : `Approve ${kept.length} step${kept.length === 1 ? "" : "s"}`}
          </Button>
          {failed && !pendingLeft && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileBundle.mutate(detail.item.id)}
            >
              <CheckCheck /> Done anyway
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => dismiss.mutate(detail.item.id)}
          >
            <Trash2 /> Dismiss
          </Button>
          {decidable.length > kept.length && kept.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {decidable.length - kept.length} left out; the secretary learns from it.
            </span>
          )}
        </footer>
      )}
    </div>
  );
}

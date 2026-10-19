/**
 * An outcome card (FR-19.6, D61, Phase 25): a fact changed, and these are the
 * follow-ups that set the rest right. Each step can be left out; one Approve
 * runs the rest in order through the Executor (`Proposals.approveBundle`).
 * A step the others hang on greys them out while it is off. Each step opens to
 * its proposal card, where it can be edited before approving.
 *
 * Phase 26: the same steps show for a playbook's bundle inside a thread
 * (`BundleCard`), with the tickets the "waiting on someone" search found as a
 * radio list (code pre-selects only a single clear match), and, after the user
 * left the same step out twice, one line offering to make that the rule.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, CheckCheck, ChevronDown, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAppMutation } from "@/app/hooks";
import { type Lookups, useLookups } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { TicketLink } from "@/components/tickets/ticket-link";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { dateTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { InboxDetail, ProposalView } from "@/services/inbox/queries";
import { PROPOSAL_LABELS, type ProposalPayload } from "@/services/proposals/schema";
import { answerOffer, offerFor } from "@/services/work/playbooks/offers";
import { foundEdits, waitingFactsOf } from "@/services/work/playbooks/waiting";
import { SITUATION_LABELS } from "@/services/work/rules";
import { type Found, type SituationRecord, situationOf } from "@/services/work/schema";
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

/** The radio value of "None of these". */
const NONE = "__none__";

function Step({
  proposal,
  label,
  required,
  checked,
  greyed,
  disabled = false,
  onCheckedChange,
  lookups,
}: {
  proposal: ProposalView;
  label: string;
  required: boolean;
  checked: boolean;
  /** Hangs on a required step that is off. */
  greyed: boolean;
  /** Cannot be kept now (the link to their ticket while none is picked). */
  disabled?: boolean;
  onCheckedChange: (on: boolean) => void;
  lookups: Lookups;
}) {
  const [open, setOpen] = useState(false);
  const { approve } = useDecisions();
  const decidable = proposal.status === "pending" || proposal.status === "failed";
  const id = `step-${proposal.id}`;
  const error = (proposal.result as { error?: string } | null)?.error;
  return (
    <li className={cn("flex flex-col gap-2 py-2", (greyed || disabled) && "opacity-50")}>
      <div className="flex items-start gap-2">
        {decidable ? (
          <Checkbox
            id={id}
            className="mt-0.5"
            checked={checked}
            disabled={greyed || disabled}
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

/** The tickets the search found in the owner's projects: pick theirs, or none. */
function FoundTickets({
  found,
  value,
  onChange,
  disabled,
}: {
  found: Found;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  if (found.results.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Their ticket</legend>
      <RadioGroup value={value} onValueChange={onChange} disabled={disabled}>
        {found.results.map((r) => (
          <div key={r.key} className="flex items-start gap-2">
            <RadioGroupItem value={r.key} id={`found-${r.key}`} className="mt-0.5" />
            <Label
              htmlFor={`found-${r.key}`}
              className="min-w-0 flex-1 flex-col items-start gap-0.5 font-normal"
            >
              <span className="text-sm">
                <TicketLink ticketKey={r.key} className="font-mono underline">
                  {r.key}
                </TicketLink>{" "}
                {r.summary}
              </span>
              {r.status && <span className="text-xs text-muted-foreground">{r.status}</span>}
            </Label>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <RadioGroupItem value={NONE} id="found-none" />
          <Label htmlFor="found-none" className="font-normal">
            None of these
          </Label>
        </div>
      </RadioGroup>
    </fieldset>
  );
}

/** "You left the comment out twice. Make that the rule?" (Phase 26). */
function OfferLine({ playbook, stepKinds }: { playbook: string; stepKinds: readonly string[] }) {
  const offer = useQuery({
    queryKey: queryKeys.instructionOffer(playbook, stepKinds),
    queryFn: ({ signal }) => run(offerFor(playbook, stepKinds), signal),
  });
  const answer = useAppMutation(
    (a: "yes" | "no") => answerOffer(offer.data ?? { playbook, stepKind: "" }, a),
    {
      invalidate: [queryKeys.inbox, queryKeys.settings, queryKeys.memories],
      success: (_r, a) => (a === "yes" ? "Standing instruction changed" : "Noted"),
    },
  );
  if (!offer.data) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
      <span className="flex-1">{offer.data.text}</span>
      <Button
        size="sm"
        className="h-7"
        disabled={answer.isPending}
        onClick={() => answer.mutate("yes")}
      >
        Yes
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={answer.isPending}
        onClick={() => answer.mutate("no")}
      >
        No
      </Button>
    </div>
  );
}

/** A step's line with the found-ticket choice applied (the link and the comment follow it). */
function lineOf(
  p: ProposalView,
  label: string,
  preview: ProposalPayload | undefined,
  choice: string | null,
  isChoice: boolean,
) {
  const payload = preview ?? p.editedPayload ?? p.payload;
  if (isChoice && payload.kind === "link_issues")
    return choice
      ? `${payload.target} is blocked by ${choice}`
      : `${payload.target} is blocked by their ticket: pick it above`;
  if (preview?.kind === "add_comment") return `Comment on ${preview.target}: "${preview.bodyMd}"`;
  return label;
}

/**
 * The steps of a bundle and its Approve: shared by outcome cards and playbook
 * bundles in a thread. `actions` adds buttons after Approve (Dismiss, Done anyway).
 */
function BundleSteps({
  bundleId,
  situation,
  proposals,
  open,
  actions,
}: {
  bundleId: string;
  situation: SituationRecord | null;
  proposals: readonly ProposalView[];
  open: boolean;
  actions?: (state: { busy: boolean; failed: boolean; pendingLeft: boolean }) => ReactNode;
}) {
  const lookups = useLookups();
  const { approveBundle } = useDecisions();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const found = situation?.rule === "waiting_on_someone" ? (situation.found ?? null) : null;
  const [picked, setPicked] = useState<string>(found?.picked ?? NONE);
  const choice = picked === NONE ? null : picked;
  const steps = [...proposals].sort((a, b) => a.seq - b.seq);
  const meta = new Map(situation?.steps.map((s) => [s.seq, s]) ?? []);
  const required = (p: ProposalView) => !!meta.get(p.seq)?.required;
  const isChoice = (p: ProposalView) => !!meta.get(p.seq)?.choice;
  // What the pick changes, shown before approving (the server applies the same).
  const facts = found ? waitingFactsOf(situation?.facts) : null;
  const preview =
    found && facts
      ? foundEdits({
          facts,
          found,
          choice,
          steps: steps
            .filter((p) => p.status === "pending" || p.status === "failed")
            .map((p) => ({
              seq: p.seq,
              payload: p.editedPayload ?? p.payload,
              choice: isChoice(p),
            })),
        })
      : null;
  const unpicked = (p: ProposalView) => !!preview?.skip.includes(p.seq);
  const decidable = steps.filter((p) => p.status === "pending" || p.status === "failed");
  const requiredOff = steps.some((p) => required(p) && p.status === "pending" && off.has(p.id));
  const greyed = (p: ProposalView) => requiredOff && !required(p);
  const kept = decidable.filter((p) => !off.has(p.id) && !greyed(p) && !unpicked(p));
  const failed = steps.some((p) => p.status === "failed");
  const pendingLeft = steps.some((p) => p.status === "pending");
  const busy = approveBundle.isPending;
  const toggle = (id: string, on: boolean) =>
    setOff((s) => {
      const next = new Set(s);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const pendingKinds = steps.filter((p) => p.status === "pending").map((p) => p.payload.kind);

  return (
    <div className="flex flex-col gap-3">
      {open && situation && pendingKinds.length > 0 && (
        <OfferLine playbook={situation.rule} stepKinds={pendingKinds} />
      )}
      {found && (
        <FoundTickets
          found={found}
          value={picked}
          onChange={setPicked}
          disabled={!open || !steps.some((p) => p.status === "pending")}
        />
      )}
      {steps.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border px-3">
          {steps.map((p) => (
            <Step
              key={p.id}
              proposal={p}
              label={lineOf(
                p,
                meta.get(p.seq)?.label ?? p.rationale ?? PROPOSAL_LABELS[p.payload.kind],
                preview?.edits.get(p.seq),
                choice,
                isChoice(p),
              )}
              required={required(p)}
              checked={!off.has(p.id) && !greyed(p) && !unpicked(p)}
              greyed={greyed(p) && p.status === "pending"}
              disabled={unpicked(p)}
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
              approveBundle.mutate({
                bundleId,
                keep: kept.map((p) => p.id),
                ...(found ? { found: choice } : {}),
              })
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
              : failed && !pendingLeft
                ? "Retry"
                : `Approve ${kept.length} step${kept.length === 1 ? "" : "s"}`}
          </Button>
          {actions?.({ busy, failed, pendingLeft })}
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

export function OutcomeCard({ detail }: { detail: InboxDetail }) {
  const { fileBundle, dismiss } = useDecisions();
  const situation = situationOf(detail.item.triage);
  const open = detail.item.status === "triaged";
  const label = situation ? SITUATION_LABELS[situation.rule] : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">Secretary</Badge>
          {label && <span>Because {label.name}</span>}
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
      <BundleSteps
        bundleId={detail.item.id}
        situation={situation}
        proposals={detail.proposals}
        open={open}
        actions={({ busy, failed, pendingLeft }) => (
          <>
            {failed && !pendingLeft && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || fileBundle.isPending}
                onClick={() => fileBundle.mutate(detail.item.id)}
              >
                <CheckCheck /> Done anyway
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || dismiss.isPending}
              onClick={() => dismiss.mutate(detail.item.id)}
            >
              <Trash2 /> Dismiss
            </Button>
          </>
        )}
      />
    </div>
  );
}

/**
 * A playbook's bundle inside a thread (Phase 26): the proposal the model made
 * and the chores code added, as one card with one Approve.
 */
export function BundleCard({
  bundleId,
  situation,
  proposals,
}: {
  bundleId: string;
  situation: SituationRecord | null;
  proposals: readonly ProposalView[];
}) {
  const label = situation ? SITUATION_LABELS[situation.rule] : null;
  const open = proposals.some((p) => p.status === "pending" || p.status === "failed");
  const { reject } = useDecisions();
  // The proposal the bundle expanded carries the bundle's id: rejecting it rejects
  // the whole card, and classify learns from it as it does from any rejection.
  const origin = proposals.find((p) => p.id === bundleId);
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Playbook</Badge>
          {label && <span>Because {label.name}</span>}
        </div>
        <p className="text-sm font-medium">{situation?.title ?? "Steps"}</p>
        {situation?.why && <p className="text-sm text-muted-foreground">{situation.why}</p>}
      </div>
      <BundleSteps
        bundleId={bundleId}
        situation={situation}
        proposals={proposals}
        open={open}
        actions={({ busy }) =>
          origin?.status === "pending" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || reject.isPending}
              onClick={() => reject.mutate(origin.id)}
            >
              <X /> Reject
            </Button>
          ) : null
        }
      />
    </div>
  );
}

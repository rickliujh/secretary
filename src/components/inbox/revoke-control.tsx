import { useMutationState, useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { Loader2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { run } from "@/app/runtime";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Proposals,
  type RevokedRecord,
  type RevokeErrorRecord,
  type RevokePlan,
} from "@/services/proposals";
import { revokeBlock } from "@/services/proposals/revoke";
import { REVOKE_MUTATION, type RevokeInput, useDecisions } from "./use-inbox";

type Revocable = {
  id: string;
  kind: string;
  status: string;
  result: unknown;
  inboxItemId?: string | null;
  /** Why local data rules it out (a sent draft, a closed sprint), from the thread query. */
  revokeBlocked?: string | null;
};

/**
 * Whether a revoke runs in this proposal's thread: a create's revoke covers what
 * acts on it, so every Revoke of the thread (the small-ask row and the expanded
 * card included) waits for it.
 */
function useRevokeRunning(p: Revocable) {
  const running = useMutationState({
    filters: { mutationKey: [...REVOKE_MUTATION], status: "pending" },
    select: (m) => m.state.variables as RevokeInput | undefined,
  });
  return running.some(
    (v) => v && (v.id === p.id || (!!p.inboxItemId && v.inboxItemId === p.inboxItemId)),
  );
}

const stepTexts = (plan: RevokePlan) =>
  plan.entries.flatMap((e) => (e.impossible ? [] : e.steps.map((s) => s.text)));

/** What a revoke left on a proposal's result (D54): done, or stopped at a failed step. */
export function RevokeOutcome({ result }: { result: unknown }) {
  const r = result as { revoked?: RevokedRecord; revokeError?: RevokeErrorRecord } | null;
  if (r?.revoked)
    return (
      <>
        <p className="text-sm text-muted-foreground">Revoked: {r.revoked.message}</p>
        {r.revoked.warning && (
          <p className="text-sm text-amber-700 dark:text-amber-300">{r.revoked.warning}</p>
        )}
      </>
    );
  if (r?.revokeError) return <p className="text-sm text-destructive">{r.revokeError.message}</p>;
  return null;
}

/**
 * Revoke on an executed proposal (FR-14): a confirmation listing every step it
 * takes, in Jira and in Secretary, read fresh when it opens. Confirming is the
 * approval of those steps. When stored or local data rules it out (FR-14.5), the
 * button is disabled and says why; it is also disabled while a revoke runs in
 * the same thread.
 */
export function RevokeControl({
  proposal,
  label = "Revoke",
}: {
  proposal: Revocable;
  label?: string;
}) {
  const { revoke } = useDecisions();
  const running = useRevokeRunning(proposal);
  const [open, setOpen] = useState(false);
  const plan = useQuery({
    queryKey: ["revoke-plan", proposal.id],
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(Proposals, (p) => p.revokePlan(proposal.id)),
        signal,
      ),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (proposal.status !== "executed" || proposal.kind === "needs_clarification") return null;
  const blocked = revokeBlock(proposal) ?? proposal.revokeBlocked ?? null;
  const again = !!(proposal.result as { revokeError?: unknown } | null)?.revokeError;
  if (blocked)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* aria-disabled rather than disabled, so the reason shows on hover and focus. */}
          <Button
            size="sm"
            variant="ghost"
            aria-disabled
            aria-description={blocked}
            className="opacity-50"
            onClick={(e) => e.preventDefault()}
          >
            <Undo2 /> {label}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{blocked}</TooltipContent>
      </Tooltip>
    );

  const data = plan.data;
  const confirm = () => {
    if (!data) return;
    revoke.mutate(
      { id: proposal.id, inboxItemId: proposal.inboxItemId ?? null, confirmed: stepTexts(data) },
      {
        onSuccess: (r) => {
          if (r.status === "revoked") {
            toast.success(r.message);
            if (r.warning) toast.warning(r.warning);
          } else toast.error(r.message);
        },
      },
    );
  };

  return (
    <>
      <Button
        size="sm"
        variant={again ? "outline" : "ghost"}
        disabled={running}
        onClick={() => setOpen(true)}
      >
        {running ? <Loader2 className="animate-spin" /> : <Undo2 />}
        {again ? `${label} again` : label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this approval?</AlertDialogTitle>
            <AlertDialogDescription>
              These steps run now, in order, in Jira and in Secretary. Revoking approves them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {plan.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading what to undo…
            </p>
          )}
          {plan.isError && (
            <p className="text-sm text-destructive">
              Could not read what to undo: {plan.error instanceof Error ? plan.error.message : ""}
            </p>
          )}
          {data && <PlanView plan={data} />}
          <AlertDialogFooter>
            <AlertDialogCancel>{data?.impossible ? "Close" : "Cancel"}</AlertDialogCancel>
            {data && !data.impossible && (
              <AlertDialogAction variant="destructive" disabled={running} onClick={confirm}>
                <Undo2 /> Revoke
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PlanView({ plan }: { plan: RevokePlan }) {
  if (plan.impossible)
    return <p className="text-sm text-destructive">It cannot be revoked: {plan.impossible}</p>;
  const many = plan.entries.length > 1;
  return (
    <ol className="flex max-h-80 flex-col gap-3 overflow-y-auto text-sm">
      {plan.entries.map((e) => (
        <li key={e.proposalId} className="flex flex-col gap-1">
          {many && <span className="font-medium">{e.title}</span>}
          {e.impossible ? (
            <span className="text-amber-700 dark:text-amber-300">Stays: {e.impossible}</span>
          ) : (
            <ul className="flex list-disc flex-col gap-0.5 pl-5">
              {e.steps.map((s) => (
                <li key={s.text}>{s.text}</li>
              ))}
              {e.notes.map((n) => (
                <li key={n} className="text-muted-foreground">
                  {n}
                </li>
              ))}
              {e.warnings.map((w) => (
                <li key={w} className="text-amber-700 dark:text-amber-300">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

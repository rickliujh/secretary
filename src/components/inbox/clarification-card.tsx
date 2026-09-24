import { HelpCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ProposalView } from "@/services/inbox/queries";
import type { Source } from "@/services/intake";
import { useDecisions, useTriage } from "./use-inbox";

/** "Needs clarification": answer it and the input is triaged again with the answer (FR-2.5). */
export function ClarificationCard({
  proposal,
  rawText,
  source,
  senderPersonId,
  onTriaged,
}: {
  proposal: ProposalView;
  rawText: string;
  source: Source;
  senderPersonId: string | null;
  onTriaged: (inboxItemId: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const triage = useTriage(onTriaged);
  const { reject } = useDecisions();
  const question = proposal.payload.kind === "needs_clarification" ? proposal.payload.question : "";
  const result = proposal.result as { answer?: string } | null;
  if (proposal.status !== "pending") {
    return (
      <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        <p>
          <HelpCircle className="mr-1 inline size-4" />
          {question}
        </p>
        {result?.answer && <p className="mt-1">You answered: {result.answer}</p>}
      </div>
    );
  }
  const send = () =>
    answer.trim() &&
    triage.mutate({
      text: rawText,
      source,
      senderPersonId,
      clarifies: { proposalId: proposal.id, answer: answer.trim() },
    });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-sm font-medium">
        <HelpCircle className="mr-1 inline size-4 text-amber-600" />
        {question}
      </p>
      {proposal.evidence && (
        <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground italic">
          “{proposal.evidence}”
        </blockquote>
      )}
      <Textarea
        aria-label="Your answer"
        rows={2}
        placeholder="Answer, e.g. 'It is about PAY-2; comment there and track the incident.'"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!answer.trim() || triage.isPending} onClick={send}>
          {triage.isPending && <Loader2 className="animate-spin" />}
          Answer and re-triage
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={triage.isPending}
          onClick={() => reject.mutate(proposal.id)}
        >
          Skip
        </Button>
        {triage.isPending && (
          <span className="text-xs text-muted-foreground">{triage.progress}</span>
        )}
      </div>
    </div>
  );
}

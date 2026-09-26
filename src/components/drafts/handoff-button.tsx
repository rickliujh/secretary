import { Link } from "@tanstack/react-router";
import { Loader2, Mail, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type HandoffBlock, handoffRecipients } from "@/lib/handoff";
import type { DraftDetail } from "@/services/comms/queries";

const NEEDS = { teams: "Teams chats need", email: "Emails need" } as const;

const blockedReason = (kind: DraftDetail["draft"]["kind"], block: HandoffBlock) =>
  block === "no-email"
    ? `${NEEDS[kind]} a person's email; add one on the People page.`
    : block === "team"
      ? `${NEEDS[kind]} a person's email. Pick a person, or copy the message.`
      : "Pick a person, or copy the message.";

/**
 * "Open in Teams" or "Open in email" (D31): hands the draft to the user's own app.
 * Disabled with the reason when the recipient has no email address.
 */
export function HandoffButton({
  detail: d,
  pending,
  onOpen,
}: {
  detail: DraftDetail;
  pending: boolean;
  onOpen: (to: string[]) => void;
}) {
  const recipients = handoffRecipients(d);
  const teams = d.draft.kind === "teams";
  const label = teams ? "Open in Teams" : "Open in email";
  const icon = pending ? (
    <Loader2 className="animate-spin" />
  ) : teams ? (
    <MessageSquare />
  ) : (
    <Mail />
  );

  if ("blocked" in recipients) {
    return (
      <Tooltip>
        {/* A disabled button gets no pointer events, so the wrapper carries the tooltip. */}
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button variant="outline" disabled>
              {icon} {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{blockedReason(d.draft.kind, recipients.blocked)}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" disabled={pending} onClick={() => onOpen(recipients.to)}>
          {icon} {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {teams
          ? "Opens a chat in Teams with the message filled in; you press Send there"
          : "Opens your default mail app, e.g. Outlook, with the email filled in; you press Send there"}
      </TooltipContent>
    </Tooltip>
  );
}

/** A link to the person's page when their email is missing, so the handoff can work. */
export function HandoffHint({ detail: d }: { detail: DraftDetail }) {
  const recipients = handoffRecipients(d);
  if (!d.person || !("blocked" in recipients) || recipients.blocked !== "no-email") return null;
  return (
    <p className="text-xs text-muted-foreground">
      No email for {d.person.displayName}, so it cannot open in{" "}
      {d.draft.kind === "teams" ? "Teams" : "your mail app"}.{" "}
      <Link to="/people" search={{ id: d.person.id }} className="underline">
        Add it on the People page
      </Link>
    </p>
  );
}

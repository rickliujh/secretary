/**
 * Next moves (FR-19.8, D62): a short ranked list, each with its date, the
 * ticket it is about (one click opens it) or the card it is (opens in the
 * Inbox). Shared by the Work tab, Today's "You're on" panel and Drafts.
 */
import { Link } from "@tanstack/react-router";
import { TicketLink } from "@/components/tickets/ticket-link";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { shortDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { NextBucket, NextMove } from "@/services/work/next";

const BUCKET_TONE: Record<NextBucket, string> = {
  overdue: TONE.danger,
  today: TONE.warning,
  sprint: TONE.info,
  later: TONE.neutral,
};

const when = (m: NextMove) => {
  if (m.bucket === "overdue") return `late, ${shortDate(m.on ?? "")}`;
  if (m.bucket === "today") return "today";
  if (!m.on) return null;
  return m.bucket === "sprint" ? `${shortDate(m.on)}, this sprint` : shortDate(m.on);
};

export function NextMoves({
  moves,
  className,
  empty,
}: {
  moves: readonly NextMove[];
  className?: string;
  /** Shown when there is nothing; nothing at all when absent. */
  empty?: string;
}) {
  if (moves.length === 0)
    return empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null;
  return (
    <ol className={cn("flex flex-col gap-1.5 text-sm", className)}>
      {moves.map((m) => {
        const date = when(m);
        return (
          <li key={m.id} className="flex flex-wrap items-center gap-2">
            {date && (
              <Badge
                variant="secondary"
                className={cn("h-5 shrink-0 border-transparent font-normal", BUCKET_TONE[m.bucket])}
              >
                {date}
              </Badge>
            )}
            {m.cardId ? (
              <Link to="/inbox" search={{ item: m.cardId }} className="min-w-0 underline">
                {m.text}
              </Link>
            ) : (
              <span className="min-w-0">{m.text}</span>
            )}
            {m.kind === "held" && (
              <span className="text-xs text-muted-foreground">
                (no card: that follow-up is off here)
              </span>
            )}
            {m.issueKey && !m.text.startsWith(m.issueKey) && <TicketLink ticketKey={m.issueKey} />}
            {m.issueKey && m.text.startsWith(m.issueKey) && (
              <TicketLink ticketKey={m.issueKey} className="text-muted-foreground">
                open
              </TicketLink>
            )}
          </li>
        );
      })}
    </ol>
  );
}

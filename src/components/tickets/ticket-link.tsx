import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A ticket key that opens the ticket panel on the current page (the `ticket`
 * search param on the root route), so closing it returns to what you were doing.
 */
export function TicketLink({
  ticketKey,
  className,
  children,
}: {
  ticketKey: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link
      to="."
      search={(prev) => ({ ...prev, ticket: ticketKey })}
      className={cn("font-mono text-xs underline", className)}
    >
      {children ?? ticketKey}
    </Link>
  );
}

/** Opens (or with null, closes) the ticket panel on the current page. */
export function useTicketPanel() {
  const navigate = useNavigate();
  return (ticketKey: string | null) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, ticket: ticketKey ?? undefined }) });
}

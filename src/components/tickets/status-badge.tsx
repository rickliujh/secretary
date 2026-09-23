import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TicketRow } from "@/services/tickets/tree";

const TONE: Record<TicketRow["statusCategory"], string> = {
  new: "bg-muted text-muted-foreground",
  indeterminate: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export function StatusBadge({
  status,
  category,
}: {
  status: string;
  category: TicketRow["statusCategory"];
}) {
  return (
    <Badge variant="secondary" className={cn("border-transparent font-normal", TONE[category])}>
      {status}
    </Badge>
  );
}

import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TicketRow } from "@/services/tickets/tree";

const CATEGORY_TONE: Record<TicketRow["statusCategory"], string> = {
  new: TONE.neutral,
  indeterminate: TONE.info,
  done: TONE.success,
};

export function StatusBadge({
  status,
  category,
}: {
  status: string;
  category: TicketRow["statusCategory"];
}) {
  return (
    <Badge
      variant="secondary"
      className={cn("border-transparent font-normal", CATEGORY_TONE[category])}
    >
      {status}
    </Badge>
  );
}

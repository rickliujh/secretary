import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Pin } from "lucide-react";
import { StatusBadge } from "@/components/tickets/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setOverride, setPinned, snooze } from "@/services/dashboard/data";
import type { FocusItem } from "@/services/dashboard/sections";
import { addBusinessDays } from "@/services/dependencies/logic";
import { localDate } from "@/services/intake";
import { useMetaMutation } from "./use-dashboard";

const FACTOR_LABELS: Record<string, string> = {
  priority: "Priority",
  due: "Due date",
  blocked: "Blocked",
  blocking: "Blocking",
  stale: "Staleness",
  dependency: "Dependency",
  pinned: "Pinned",
  override: "Adjustment",
};

/** "Why here": every factor, its reason and its points (FR-5.2). */
function WhyHere({ item }: { item: FocusItem }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 font-mono text-xs tabular-nums"
          aria-label={`Why ${item.key} is here`}
        >
          {item.score.toFixed(1)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 text-sm font-medium">Why {item.key} is here</p>
        <table className="w-full text-sm">
          <tbody>
            {item.contributions.map((c) => (
              <tr key={c.factor} className="align-top">
                <td className="py-0.5 pr-2 text-muted-foreground">{FACTOR_LABELS[c.factor]}</td>
                <td className="py-0.5">{c.reason}</td>
                <td className="py-0.5 pl-2 text-right font-mono tabular-nums">
                  {c.points > 0 ? "+" : ""}
                  {c.points.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">Weights are in Settings &gt; Ranking.</p>
      </PopoverContent>
    </Popover>
  );
}

function Actions({ item }: { item: FocusItem }) {
  const pin = useMetaMutation(
    (on: boolean) => setPinned(item.key, on),
    item.pinned ? "Unpinned" : "Pinned",
  );
  const doSnooze = useMetaMutation(
    (until: string) => snooze(item.key, until),
    `Snoozed ${item.key}`,
  );
  const adjust = useMetaMutation(
    (points: number | null) => setOverride(item.key, points),
    "Ranking adjusted",
  );
  const until = (days: number) =>
    new Date(`${addBusinessDays(localDate(), days)}T00:00:00`).toISOString();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Actions for ${item.key}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Only on this computer</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => pin.mutate(!item.pinned)}>
          {item.pinned ? "Unpin" : "Pin to the top"}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Snooze</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => doSnooze.mutate(until(1))}>
              Until tomorrow
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => doSnooze.mutate(until(3))}>
              3 working days
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => doSnooze.mutate(until(5))}>A week</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Adjust ranking</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {[5, 2, -2, -5].map((p) => (
              <DropdownMenuItem key={p} onSelect={() => adjust.mutate(p)}>
                {p > 0 ? `Raise (+${p})` : `Lower (${p})`}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!item.priorityOverride}
              onSelect={() => adjust.mutate(null)}
            >
              Clear adjustment
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FocusList({ items }: { items: FocusItem[] }) {
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing assigned to you or under your tracked epics.
      </p>
    );
  return (
    <ol className="flex flex-col">
      {items.map((item, i) => (
        <li key={item.key} className="flex items-center gap-2 border-b py-1.5 last:border-b-0">
          <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
          {item.pinned && <Pin className="size-3.5 text-muted-foreground" aria-label="Pinned" />}
          <Link to="/tickets" search={{ key: item.key }} className="font-mono text-xs underline">
            {item.key}
          </Link>
          <span className="min-w-0 flex-1 truncate text-sm">{item.summary}</span>
          <span className="hidden text-xs text-muted-foreground lg:inline">
            {item.contributions[0]?.reason}
          </span>
          <StatusBadge status={item.status} category={item.statusCategory} />
          {item.priorityOverride ? (
            <Badge variant="outline">
              {item.priorityOverride > 0 ? "+" : ""}
              {item.priorityOverride}
            </Badge>
          ) : null}
          <WhyHere item={item} />
          <Actions item={item} />
        </li>
      ))}
    </ol>
  );
}

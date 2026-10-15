import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setOverride, setPinned } from "@/services/dashboard/data";
import type { FocusItem } from "@/services/dashboard/sections";
import { useMetaMutation } from "./use-today";

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
export function WhyHere({ item }: { item: FocusItem }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-1.5 font-mono text-xs tabular-nums"
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
                <td className="py-0.5 break-words">{c.reason}</td>
                <td className="py-0.5 pl-2 text-right font-mono tabular-nums">
                  {c.points > 0 ? "+" : ""}
                  {c.points.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">Weights are in Settings &gt; Advanced.</p>
      </PopoverContent>
    </Popover>
  );
}

/** Pin and ranking adjustment: local only (FR-5.3), for a row's menu. */
export function RankingItems({ item }: { item: FocusItem }) {
  const pin = useMetaMutation(
    (on: boolean) => setPinned(item.key, on),
    (_a, on) => (on ? `Pinned ${item.key}` : `Unpinned ${item.key}`),
  );
  const adjust = useMetaMutation(
    (points: number | null) => setOverride(item.key, points),
    "Ranking adjusted",
  );
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Only on this computer</DropdownMenuLabel>
      <DropdownMenuItem disabled={pin.isPending} onSelect={() => pin.mutate(!item.pinned)}>
        {item.pinned ? "Unpin" : "Pin to the top"}
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Adjust ranking</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {[5, 2, -2, -5].map((p) => (
            <DropdownMenuItem key={p} onSelect={() => adjust.mutate(p)}>
              {p > 0 ? `Raise (+${p})` : `Lower (${p})`}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!item.priorityOverride} onSelect={() => adjust.mutate(null)}>
            Clear adjustment
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

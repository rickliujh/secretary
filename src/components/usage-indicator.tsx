import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { queryKeys } from "@/app/query-client";
import { run, SESSION_STARTED_AT } from "@/app/runtime";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TIERS } from "@/services/llm/tasks";
import { usageSince } from "@/services/llm/usage";

export const formatTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

/** Session token total with a per-tier breakdown (FR-9.5). */
export function UsageIndicator() {
  const { data } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: ({ signal }) => run(usageSince(SESSION_STARTED_AT), signal),
    refetchInterval: 15_000,
  });
  const total = data ? data.inputTokens + data.outputTokens : 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1 font-mono tabular-nums">
          <Coins className="size-3" />
          {formatTokens(total)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        <p className="mb-1 font-medium">Tokens this session ({data?.calls ?? 0} calls)</p>
        {TIERS.map((tier) => {
          const t = data?.byTier[tier];
          return (
            <p key={tier} className="tabular-nums">
              {tier}: {formatTokens(t?.inputTokens ?? 0)} in / {formatTokens(t?.outputTokens ?? 0)}{" "}
              out
            </p>
          );
        })}
      </TooltipContent>
    </Tooltip>
  );
}

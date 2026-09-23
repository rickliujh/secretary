import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/app/query-client";
import { run, SESSION_STARTED_AT } from "@/app/runtime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTokens } from "@/components/usage-indicator";
import { TIERS } from "@/services/llm/tasks";
import { recentCalls, usageSince } from "@/services/llm/usage";

const time = (iso: string) => new Date(iso).toLocaleTimeString();

export function UsageSection() {
  const session = useQuery({
    queryKey: queryKeys.usage,
    queryFn: ({ signal }) => run(usageSince(SESSION_STARTED_AT), signal),
  });
  const calls = useQuery({
    queryKey: queryKeys.recentCalls,
    queryFn: ({ signal }) => run(recentCalls(50), signal),
  });
  const s = session.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>This session</CardDescription>
            <CardTitle className="tabular-nums">
              {formatTokens((s?.inputTokens ?? 0) + (s?.outputTokens ?? 0))}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {s?.calls ?? 0} calls, {s?.failed ?? 0} failed
          </CardContent>
        </Card>
        {TIERS.map((tier) => (
          <Card key={tier} size="sm">
            <CardHeader>
              <CardDescription className="capitalize">{tier}</CardDescription>
              <CardTitle className="tabular-nums">
                {formatTokens(
                  (s?.byTier[tier].inputTokens ?? 0) + (s?.byTier[tier].outputTokens ?? 0),
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {formatTokens(s?.byTier[tier].inputTokens ?? 0)} in,{" "}
              {formatTokens(s?.byTier[tier].outputTokens ?? 0)} out
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>The last 50 model calls, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">ms</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(calls.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="tabular-nums">{time(c.at)}</TableCell>
                  <TableCell className="font-mono text-xs">{c.task}</TableCell>
                  <TableCell>{c.tier ?? "-"}</TableCell>
                  <TableCell className="font-mono text-xs">{c.model}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.inputTokens ?? "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.outputTokens ?? "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.durationMs}</TableCell>
                  <TableCell className="flex flex-wrap gap-1">
                    <Badge variant={c.ok ? "secondary" : "destructive"}>
                      {c.ok ? "ok" : (c.errorKind ?? "failed")}
                    </Badge>
                    {c.validationOk === false && <Badge variant="outline">invalid</Badge>}
                    {c.repair && <Badge variant="outline">repair</Badge>}
                    {c.escalated && <Badge variant="outline">escalated</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {calls.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No calls yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

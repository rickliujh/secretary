import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Building2, CircleDashed, Hourglass, Plus, Send, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { DependencyDialog } from "@/components/dependencies/dependency-dialog";
import { DependencyRowView } from "@/components/dependencies/dependency-row";
import { DependencySheet } from "@/components/dependencies/dependency-sheet";
import { useChaseDraft } from "@/components/drafts/use-drafts";
import { PageHeader, Planned } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { groupByOwner } from "@/services/dependencies/logic";
import { listDependencies } from "@/services/dependencies/queries";
import { localDate } from "@/services/intake";

export const Route = createFileRoute("/waiting")({
  validateSearch: z.object({ id: z.string().optional() }),
  component: WaitingPage,
});

const OWNER_ICON = { person: UserRound, team: Building2, none: CircleDashed } as const;

function WaitingPage() {
  const { id } = Route.useSearch();
  const navigate = useNavigate({ from: "/waiting" });
  const chase = useChaseDraft();
  const [includeResolved, setIncludeResolved] = useState(false);
  const [dueOnly, setDueOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: queryKeys.dependencyList(includeResolved),
    queryFn: ({ signal }) => run(listDependencies({ includeResolved }), signal),
  });
  const today = localDate();
  const groups = useMemo(() => {
    const all = groupByOwner(list.data ?? [], today);
    return dueOnly
      ? all
          .map((g) => ({
            ...g,
            items: g.items.filter((i) => i.timing.followupDue || i.timing.overdueDays > 0),
          }))
          .filter((g) => g.items.length > 0)
      : all;
  }, [list.data, today, dueOnly]);
  const overdue = (list.data ?? []).filter(
    (d) => d.status !== "resolved" && d.expectedAt && d.expectedAt < today,
  ).length;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Waiting on"
        description="What your tickets wait on, grouped by who owns it, most overdue first."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add dependency
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-muted-foreground">
          {(list.data ?? []).filter((d) => d.status !== "resolved").length} open · {overdue} overdue
        </span>
        <div className="flex items-center gap-2">
          <Switch id="due-only" checked={dueOnly} onCheckedChange={setDueOnly} />
          <Label htmlFor="due-only" className="font-normal">
            Needs action today
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="show-resolved"
            checked={includeResolved}
            onCheckedChange={setIncludeResolved}
          />
          <Label htmlFor="show-resolved" className="font-normal">
            Show resolved
          </Label>
        </div>
      </div>
      {list.isSuccess && groups.length === 0 && (
        <Planned
          icon={Hourglass}
          title={dueOnly ? "Nothing needs chasing today" : "Nothing to wait on"}
          description="Dependencies come from approved inbox proposals, or add one here or on a ticket."
        />
      )}
      {groups.map((g) => {
        const Icon = OWNER_ICON[g.owner.type];
        return (
          <section
            key={`${g.owner.type}:${g.owner.id ?? g.owner.name}`}
            className="rounded-lg border"
          >
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <Icon className="size-4 text-muted-foreground" />
              <h2 className="font-medium">{g.owner.name}</h2>
              <span className="text-sm text-muted-foreground">{g.items.length}</span>
              <span className="ml-auto flex gap-1">
                {g.maxOverdue > 0 && (
                  <Badge variant="destructive">up to {g.maxOverdue}d overdue</Badge>
                )}
                {g.due > 0 && <Badge variant="secondary">{g.due} to chase</Badge>}
              </span>
            </header>
            <ul className="divide-y">
              {g.items.map((item) => (
                <li key={item.id} className="flex items-center gap-1 pr-2">
                  <div className="min-w-0 flex-1">
                    <DependencyRowView
                      dep={item}
                      timing={item.timing}
                      onOpen={() => navigate({ search: { id: item.id } })}
                    />
                  </div>
                  {item.status !== "resolved" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={chase.isPending}
                      onClick={() => chase.mutate(item.id)}
                    >
                      <Send /> Draft a chase
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <DependencySheet dependencyId={id} onClose={() => navigate({ search: {} })} />
      <DependencyDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

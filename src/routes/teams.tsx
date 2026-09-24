import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { TeamDialog } from "@/components/directory/team-dialog";
import { TeamSheet } from "@/components/directory/team-sheet";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { listPeople, listTeams } from "@/services/directory/queries";

export const Route = createFileRoute("/teams")({
  validateSearch: z.object({ id: z.string().optional() }),
  component: TeamsPage,
});

function TeamsPage() {
  const { id } = Route.useSearch();
  const navigate = useNavigate({ from: "/teams" });
  const [adding, setAdding] = useState(false);
  const teams = useQuery({
    queryKey: queryKeys.teams,
    queryFn: ({ signal }) => run(listTeams, signal),
  });
  const people = useQuery({
    queryKey: queryKeys.people,
    queryFn: ({ signal }) => run(listPeople, signal),
  });
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of people.data ?? []) if (p.teamId) m.set(p.teamId, (m.get(p.teamId) ?? 0) + 1);
    return m;
  }, [people.data]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Teams"
        description="Who does what, what to contact them for, and their Confluence pages."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add team
          </Button>
        }
      />
      {teams.isSuccess && teams.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No teams yet.</p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {(teams.data ?? []).map((t) => (
          <Card
            key={t.id}
            size="sm"
            className="cursor-pointer transition-colors hover:bg-muted/50"
            tabIndex={0}
            onClick={() => navigate({ search: { id: t.id } })}
            onKeyDown={(e) => e.key === "Enter" && navigate({ search: { id: t.id } })}
          >
            <CardHeader>
              <CardTitle>{t.name}</CardTitle>
              <CardDescription className="line-clamp-2">
                {t.function ?? t.contactFor ?? "No description"}
              </CardDescription>
            </CardHeader>
            <CardFooter className="gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Users className="size-3.5" /> {counts.get(t.id) ?? 0}
              </span>
              {t.channel && <span className="truncate">{t.channel}</span>}
            </CardFooter>
          </Card>
        ))}
      </div>
      <TeamSheet teamId={id} onClose={() => navigate({ search: {} })} />
      <TeamDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={(newId) => navigate({ search: { id: newId } })}
      />
    </div>
  );
}

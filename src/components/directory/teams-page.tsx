import { Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { usePeople, useTeams } from "@/app/queries";
import { TeamDialog } from "@/components/directory/team-dialog";
import { TeamSheet } from "@/components/directory/team-sheet";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/** Teams (FR-4); the Teams tab of `/context` (D50), with the open team as `id`. */
export function TeamsPage({
  selectedId: id,
  onSelect,
}: {
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const [adding, setAdding] = useState(false);
  const teams = useTeams();
  const people = usePeople();
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
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => e.key === "Enter" && onSelect(t.id)}
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
      <TeamSheet teamId={id} onClose={() => onSelect(undefined)} />
      <TeamDialog open={adding} onOpenChange={setAdding} onSaved={onSelect} />
    </div>
  );
}

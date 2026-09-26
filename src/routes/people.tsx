import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Archive, Plus, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast } from "@/app/hooks";
import { usePeople, useTeams } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { PersonDialog } from "@/components/directory/person-dialog";
import { PersonSheet } from "@/components/directory/person-sheet";
import { useDirectoryMutation } from "@/components/directory/use-directory";
import { PageHeader } from "@/components/page";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createPerson, jiraUsersWithoutContact } from "@/services/directory/queries";
import type { Profile } from "@/services/directory/schema";
import { exportDirectory, importDirectory } from "@/services/directory/transfer";

export const Route = createFileRoute("/people")({
  validateSearch: z.object({ id: z.string().optional() }),
  component: PeoplePage,
});

const SUGGESTIONS_SHOWN = 8;

function Backup() {
  const client = useQueryClient();
  const onError = useErrorToast();
  const exportMutation = useMutation({
    mutationFn: async () => {
      const path = await saveDialog({
        defaultPath: `secretary-directory-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return null;
      const data = await run(exportDirectory);
      await writeTextFile(path, JSON.stringify(data, null, 2));
      return data;
    },
    onSuccess: (d) =>
      d && toast.success(`Exported ${d.teams.length} teams and ${d.people.length} contacts`),
    onError: (e) => onError(e),
  });
  const importMutation = useMutation({
    mutationFn: async () => {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return null;
      return run(importDirectory(JSON.parse(await readTextFile(path))));
    },
    onSuccess: (r) => {
      if (!r) return;
      void client.invalidateQueries({ queryKey: queryKeys.directory });
      toast.success(`Imported ${r.teams} teams, ${r.people} contacts and ${r.notes} notes`);
    },
    onError: (e) => onError(e),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Archive /> Backup
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => exportMutation.mutate()}>
          Export teams and contacts...
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => importMutation.mutate()}>
          Import from file...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PeoplePage() {
  const { id } = Route.useSearch();
  const navigate = useNavigate({ from: "/people" });
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const people = usePeople();
  const teams = useTeams();
  const suggestions = useQuery({
    queryKey: queryKeys.jiraUserSuggestions,
    queryFn: ({ signal }) => run(jiraUsersWithoutContact, signal),
  });
  const addFromJira = useDirectoryMutation(
    (u: { displayName: string; username: string; email: string | null }) =>
      createPerson({ displayName: u.displayName, jiraUsername: u.username, email: u.email ?? "" }),
    (_id, u) => `Added ${u.displayName}`,
  );

  const teamName = useMemo(
    () => new Map((teams.data ?? []).map((t) => [t.id, t.name])),
    [teams.data],
  );
  const q = text.trim().toLowerCase();
  const rows = (people.data ?? []).filter(
    (p) =>
      !q ||
      [p.displayName, p.title, p.jiraUsername, p.email, p.teamId ? teamName.get(p.teamId) : ""]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="People"
        description="Contacts with titles, teams and how they like to be addressed."
        actions={
          <div className="flex gap-2">
            <Backup />
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add contact
            </Button>
          </div>
        }
      />
      {(suggestions.data?.length ?? 0) > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>From Jira</CardTitle>
            <CardDescription>
              People on your synced tickets who are not contacts yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {(suggestions.data ?? []).slice(0, SUGGESTIONS_SHOWN).map((u) => (
              <Button
                key={u.username}
                variant="outline"
                size="sm"
                disabled={addFromJira.isPending}
                onClick={() => addFromJira.mutate(u)}
              >
                <UserPlus /> {u.displayName}
                <span className="text-muted-foreground">{u.issues}</span>
              </Button>
            ))}
          </CardContent>
        </Card>
      )}
      <SearchInput
        className="w-72"
        aria-label="Filter contacts"
        placeholder="Filter"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Jira</TableHead>
              <TableHead>Prefers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => {
              const profile = p.profile as Profile;
              return (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  data-state={p.id === id ? "selected" : undefined}
                  tabIndex={0}
                  onClick={() => navigate({ search: { id: p.id } })}
                  onKeyDown={(e) => e.key === "Enter" && navigate({ search: { id: p.id } })}
                >
                  <TableCell className="font-medium">{p.displayName}</TableCell>
                  <TableCell>{p.title}</TableCell>
                  <TableCell>{p.teamId ? teamName.get(p.teamId) : ""}</TableCell>
                  <TableCell className="font-mono text-xs">{p.jiraUsername}</TableCell>
                  <TableCell className="flex flex-wrap gap-1">
                    {profile.preferredChannel && (
                      <Badge variant="outline">{profile.preferredChannel}</Badge>
                    )}
                    {profile.formality && <Badge variant="outline">{profile.formality}</Badge>}
                    {profile.detail && <Badge variant="outline">{profile.detail}</Badge>}
                  </TableCell>
                </TableRow>
              );
            })}
            {people.isSuccess && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {people.data.length === 0 ? "No contacts yet." : "No matches."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <PersonSheet personId={id} onClose={() => navigate({ search: {} })} />
      <PersonDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={(newId) => navigate({ search: { id: newId } })}
      />
    </div>
  );
}

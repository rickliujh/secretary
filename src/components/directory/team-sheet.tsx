import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Markdown } from "@/components/markdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { deleteTeam, getTeam } from "@/services/directory/queries";
import { ContextNotes } from "./context-notes";
import { Section } from "./person-sheet";
import { TeamDialog } from "./team-dialog";
import { useDirectoryMutation } from "./use-directory";

export function TeamSheet({
  teamId,
  onClose,
}: {
  teamId: string | undefined;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.team(teamId ?? ""),
    queryFn: ({ signal }) => run(getTeam(teamId ?? ""), signal),
    enabled: !!teamId,
  });
  const remove = useDirectoryMutation((id: string) => deleteTeam(id), "Team deleted");
  const d = detail.data;
  return (
    <Sheet open={!!teamId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetDescription>{d?.team.function ?? "Team"}</SheetDescription>
          <SheetTitle className="text-lg">{d?.team.name}</SheetTitle>
          {d && (
            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-destructive">
                    <Trash2 /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {d.team.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Members stay as contacts without a team. The team's context notes are deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => remove.mutate(d.team.id, { onSuccess: onClose })}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </SheetHeader>
        {d === null && (
          <p className="p-4 text-sm text-muted-foreground">This team no longer exists.</p>
        )}
        {d && (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 p-4">
              {d.team.contactFor && <Section title="Contact them for">{d.team.contactFor}</Section>}
              {d.team.channel && <Section title="Primary channel">{d.team.channel}</Section>}
              {d.team.escalationPath && (
                <Section title="Escalation path">{d.team.escalationPath}</Section>
              )}
              <Section title={`Members (${d.members.length})`}>
                {d.members.length === 0 && (
                  <span className="text-muted-foreground">No members yet.</span>
                )}
                <ul className="flex flex-col gap-1">
                  {d.members.map((m) => (
                    <li key={m.id}>
                      <Link to="/people" search={{ id: m.id }} className="underline">
                        {m.displayName}
                      </Link>
                      {m.title && <span className="text-muted-foreground"> · {m.title}</span>}
                    </li>
                  ))}
                </ul>
              </Section>
              {d.team.confluenceUrls.length > 0 && (
                <Section title="Confluence links">
                  <ul className="flex flex-col gap-1">
                    {d.team.confluenceUrls.map((u) => (
                      <li key={u}>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 underline"
                          onClick={() => void openUrl(u)}
                        >
                          <ExternalLink className="size-3.5" />
                          {u}
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              {d.team.notesMd && (
                <Section title="Notes">
                  <Markdown>{d.team.notesMd}</Markdown>
                </Section>
              )}
              <ContextNotes subject={{ type: "team", id: d.team.id }} />
            </div>
          </ScrollArea>
        )}
        {d && <TeamDialog team={d.team} open={editing} onOpenChange={setEditing} />}
      </SheetContent>
    </Sheet>
  );
}

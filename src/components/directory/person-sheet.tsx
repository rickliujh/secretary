import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Mail, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/tickets/status-badge";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { deletePerson, getPerson } from "@/services/directory/queries";
import type { Profile } from "@/services/directory/schema";
import { ContextNotes } from "./context-notes";
import { PersonDialog } from "./person-dialog";
import { useDirectoryMutation } from "./use-directory";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

const PROFILE_LABELS: [keyof Profile, string][] = [
  ["formality", "Formality"],
  ["detail", "Detail"],
  ["tone", "Tone"],
  ["responsiveness", "Responsiveness"],
  ["preferredChannel", "Channel"],
  ["language", "Language"],
];

function ProfileBadges({ profile }: { profile: Profile }) {
  const known = PROFILE_LABELS.filter(([k]) => profile[k]);
  if (known.length === 0) return <span className="text-muted-foreground">No profile yet.</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {known.map(([k, label]) => (
        <Badge key={k} variant="outline">
          {label}: {profile[k]}
        </Badge>
      ))}
    </span>
  );
}

export function PersonSheet({
  personId,
  onClose,
}: {
  personId: string | undefined;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.person(personId ?? ""),
    queryFn: ({ signal }) => run(getPerson(personId ?? ""), signal),
    enabled: !!personId,
  });
  const remove = useDirectoryMutation((id: string) => deletePerson(id), "Contact deleted");
  const d = detail.data;
  return (
    <Sheet open={!!personId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetDescription>
            {[d?.person.title, d?.team?.name].filter(Boolean).join(" · ") || "Contact"}
          </SheetDescription>
          <SheetTitle className="text-lg">{d?.person.displayName}</SheetTitle>
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
                    <AlertDialogTitle>Delete {d.person.displayName}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Their context notes are deleted too.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => remove.mutate(d.person.id, { onSuccess: onClose })}
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
          <p className="p-4 text-sm text-muted-foreground">This contact no longer exists.</p>
        )}
        {d && (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 p-4">
              <Section title="Contact">
                <dl className="grid grid-cols-[7rem_1fr] gap-y-1">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd>
                    {d.person.email ? (
                      <a
                        className="inline-flex items-center gap-1 underline"
                        href={`mailto:${d.person.email}`}
                      >
                        <Mail className="size-3.5" />
                        {d.person.email}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Jira</dt>
                  <dd className="font-mono text-xs">
                    {d.person.jiraUsername ?? (
                      <span className="font-sans text-muted-foreground">Not linked</span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Team</dt>
                  <dd>
                    {d.team ? (
                      <Link to="/teams" search={{ id: d.team.id }} className="underline">
                        {d.team.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </dd>
                </dl>
              </Section>
              <Section title="Communication profile">
                <ProfileBadges profile={d.person.profile as Profile} />
              </Section>
              {d.person.responsibilities && (
                <Section title="Responsibilities">{d.person.responsibilities}</Section>
              )}
              {d.person.notesMd && (
                <Section title="Notes">
                  <Markdown>{d.person.notesMd}</Markdown>
                </Section>
              )}
              {d.person.jiraUsername && (
                <Section title={`Assigned tickets (${d.issues.length})`}>
                  {d.issues.length === 0 && (
                    <span className="text-muted-foreground">None in the local cache.</span>
                  )}
                  <ul className="flex flex-col gap-1">
                    {d.issues.map((i) => (
                      <li key={i.key} className="flex items-center gap-2">
                        <Link
                          to="/tickets"
                          search={{ key: i.key }}
                          className="font-mono text-xs underline"
                        >
                          {i.key}
                        </Link>
                        <span className="min-w-0 flex-1 truncate">{i.summary}</span>
                        <StatusBadge status={i.status} category={i.statusCategory} />
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              <ContextNotes subject={{ type: "person", id: d.person.id }} />
            </div>
          </ScrollArea>
        )}
        {d && <PersonDialog person={d.person} open={editing} onOpenChange={setEditing} />}
      </SheetContent>
    </Sheet>
  );
}

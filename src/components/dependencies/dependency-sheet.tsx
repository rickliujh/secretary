import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  ExternalLink,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { useChaseDraft } from "@/components/drafts/use-drafts";
import { useLookups } from "@/components/inbox/use-inbox";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { dateTime } from "@/lib/time";
import { timing } from "@/services/dependencies/logic";
import {
  deleteDependency,
  getDependency,
  mirror,
  setStatus,
} from "@/services/dependencies/queries";
import { localDate } from "@/services/intake";
import { DependencyDialog } from "./dependency-dialog";
import { FollowupDialog } from "./followup-dialog";
import { TimingBadges } from "./timing-badges";
import { useDependencyMutation } from "./use-dependencies";

export function DependencySheet({
  dependencyId,
  onClose,
}: {
  dependencyId: string | undefined;
  onClose: () => void;
}) {
  const lookups = useLookups();
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.dependency(dependencyId ?? ""),
    queryFn: ({ signal }) => run(getDependency(dependencyId ?? ""), signal),
    enabled: !!dependencyId,
  });
  const status = useDependencyMutation(
    (s: "resolved" | "waiting") => setStatus(dependencyId ?? "", s),
    (_a, s) => (s === "resolved" ? "Marked resolved" : "Reopened"),
  );
  const toggleMirror = useDependencyMutation(
    (on: boolean) => mirror(dependencyId ?? "", on),
    (_a, on) => (on ? "Mirrored to Jira" : "Removed from Jira"),
  );
  const chase = useChaseDraft();
  const remove = useDependencyMutation(
    () => deleteDependency(dependencyId ?? ""),
    "Dependency deleted",
  );

  const d = detail.data?.dependency;
  const owner = d?.ownerPersonId
    ? lookups.person.get(d.ownerPersonId)?.displayName
    : d?.ownerTeamId
      ? lookups.team.get(d.ownerTeamId)?.name
      : undefined;
  const t = d ? timing(d, localDate()) : null;
  const resolved = d?.status === "resolved";

  return (
    <Sheet open={!!dependencyId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetDescription className="flex items-center gap-2">
            {d && (
              <Link to="/tickets" search={{ key: d.issueKey }} className="font-mono underline">
                {d.issueKey}
              </Link>
            )}
            {d && <Badge variant="outline">{d.kind}</Badge>}
            {d && <Badge variant={resolved ? "secondary" : "default"}>{d.status}</Badge>}
          </SheetDescription>
          <SheetTitle className="text-lg">{d?.label}</SheetTitle>
          {d && t && (
            <TimingBadges timing={t} expectedAt={d.expectedAt} nextFollowupAt={d.nextFollowupAt} />
          )}
          {d && (
            <div className="flex flex-wrap gap-2 pt-2">
              {!resolved && (
                <Button size="sm" onClick={() => setLogging(true)}>
                  <MessageSquarePlus /> Log follow-up
                </Button>
              )}
              {!resolved && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={chase.isPending}
                  onClick={() => dependencyId && chase.mutate(dependencyId)}
                >
                  <Send /> Draft a chase
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={status.isPending}
                onClick={() => status.mutate(resolved ? "waiting" : "resolved")}
              >
                {resolved ? <RotateCcw /> : <CheckCircle2 />}
                {resolved ? "Reopen" : "Resolve"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="ghost" className="text-destructive">
                    <Trash2 /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this dependency?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its follow-up history is deleted too, and a mirrored link is removed from
                      Jira.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => remove.mutate(undefined, { onSuccess: onClose })}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </SheetHeader>
        {detail.data === null && (
          <p className="p-4 text-sm text-muted-foreground">This dependency no longer exists.</p>
        )}
        {d && (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 p-4 text-sm">
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
                <dt className="text-muted-foreground">Owner</dt>
                <dd>{owner ?? <span className="text-muted-foreground">None</span>}</dd>
                <dt className="text-muted-foreground">Reference</dt>
                <dd className="flex items-center gap-2">
                  {d.externalRef ? (
                    <span className="font-mono text-xs">{d.externalRef}</span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                  {d.externalUrl && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label="Open reference"
                      onClick={() => void openUrl(d.externalUrl ?? "")}
                    >
                      <ExternalLink className="size-3.5" />
                    </Button>
                  )}
                </dd>
                <dt className="text-muted-foreground">Requested</dt>
                <dd>{d.requestedAt ? dateTime(d.requestedAt) : "Unknown"}</dd>
                <dt className="text-muted-foreground">Expected</dt>
                <dd>{d.expectedAt ?? "Not set"}</dd>
                <dt className="text-muted-foreground">Next follow-up</dt>
                <dd>{d.nextFollowupAt ?? "None"}</dd>
                {d.resolvedAt && (
                  <>
                    <dt className="text-muted-foreground">Resolved</dt>
                    <dd>{dateTime(d.resolvedAt)}</dd>
                  </>
                )}
              </dl>
              <div className="flex items-center gap-2">
                <Switch
                  id="dep-mirror"
                  checked={!!d.mirrorRemoteLinkId}
                  disabled={toggleMirror.isPending}
                  onCheckedChange={(on) => toggleMirror.mutate(on)}
                />
                <Label htmlFor="dep-mirror" className="font-normal">
                  Show on the Jira issue as a remote link
                </Label>
              </div>
              {d.notesMd && <Markdown>{d.notesMd}</Markdown>}
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Follow-ups ({detail.data?.timeline.length ?? 0})</h3>
                {detail.data?.timeline.length === 0 && (
                  <p className="text-muted-foreground">You have not chased this yet.</p>
                )}
                <ol className="flex flex-col gap-2 border-l pl-4">
                  {(detail.data?.timeline ?? []).map((f) => (
                    <li key={f.id}>
                      <p className="text-xs text-muted-foreground">
                        {dateTime(f.at)} · {f.channel}
                      </p>
                      {f.summary && <p>{f.summary}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </ScrollArea>
        )}
        {d && <DependencyDialog dependency={d} open={editing} onOpenChange={setEditing} />}
        {d && <FollowupDialog dependencyId={d.id} open={logging} onOpenChange={setLogging} />}
      </SheetContent>
    </Sheet>
  );
}

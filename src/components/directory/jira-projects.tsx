/**
 * A contact's or team's Jira projects (FR-19.7, Phase 26): where the "waiting
 * on someone" playbook looks for their ticket. Projects you add are yours and
 * stay; those seen on their synced tickets are filled in after each sync,
 * shown apart, and can be removed (a sync then leaves them out until they are
 * restored). Adding offers the projects the app knows; a key can be typed.
 */
import { useQuery } from "@tanstack/react-query";
import { Plus, Undo2, X } from "lucide-react";
import { useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { JiraProjectEntry } from "@/db/schema";
import { setInferredOff, setJiraProjects } from "@/services/directory/projects";
import { syncedProjectKeys } from "@/services/small-asks/queries";
import { useDirectoryMutation } from "./use-directory";

const KEY = /^[A-Z][A-Z0-9_]+$/;

export function JiraProjects({
  subject,
  id,
  entries,
}: {
  subject: "person" | "team";
  id: string;
  entries: readonly JiraProjectEntry[];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const known = useQuery({
    queryKey: queryKeys.syncedProjects,
    queryFn: ({ signal }) => run(syncedProjectKeys, signal),
    enabled: open,
  });
  const save = useDirectoryMutation((keys: string[]) => setJiraProjects(subject, id, keys));
  const toggle = useDirectoryMutation((i: { key: string; off: boolean }) =>
    setInferredOff(subject, id, i.key, i.off),
  );
  const busy = save.isPending || toggle.isPending;
  const mine = entries.filter((e) => e.by === "user").map((e) => e.key);
  const seen = entries.filter((e) => e.by === "sync" && !e.off).map((e) => e.key);
  const removed = entries.filter((e) => e.by === "sync" && e.off).map((e) => e.key);
  const all = new Set([...mine, ...seen]);
  const typed = text.trim().toUpperCase();
  const options = (known.data ?? []).filter(
    (k) => !mine.includes(k) && (!typed || k.includes(typed)),
  );
  const add = (key: string) => {
    save.mutate([...mine, key]);
    setOpen(false);
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {mine.map((k) => (
          <Badge key={k} variant="secondary" className="gap-1 font-mono">
            {k}
            <button
              type="button"
              aria-label={`Remove ${k}`}
              className="rounded-sm opacity-70 hover:opacity-100"
              disabled={busy}
              onClick={() => save.mutate(mine.filter((x) => x !== k))}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {seen.map((k) => (
          <Badge
            key={k}
            variant="outline"
            className="gap-1 font-mono text-muted-foreground"
            title="Seen on their synced tickets; refreshed at every sync"
          >
            {k}
            <button
              type="button"
              aria-label={`Remove ${k}; a sync will not add it back`}
              className="rounded-sm opacity-70 hover:opacity-100"
              disabled={busy}
              onClick={() => toggle.mutate({ key: k, off: true })}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {removed.map((k) => (
          <Badge
            key={k}
            variant="outline"
            className="gap-1 font-mono text-muted-foreground"
            title="Removed: a sync does not add it back"
          >
            <span className="line-through">{k}</span>
            <button
              type="button"
              aria-label={`Restore ${k}`}
              className="rounded-sm opacity-70 hover:opacity-100"
              disabled={busy}
              onClick={() => toggle.mutate({ key: k, off: false })}
            >
              <Undo2 className="size-3" />
            </button>
          </Badge>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-6 px-2" disabled={busy}>
              <Plus /> Add
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput placeholder="Project key" value={text} onValueChange={setText} />
              <CommandList>
                <CommandEmpty>
                  {KEY.test(typed) ? "Not a project the app knows yet." : "Type a project key."}
                </CommandEmpty>
                {KEY.test(typed) && !all.has(typed) && !options.includes(typed) && (
                  <CommandGroup>
                    <CommandItem value={`add ${typed}`} onSelect={() => add(typed)}>
                      Add {typed}
                    </CommandItem>
                  </CommandGroup>
                )}
                {options.length > 0 && (
                  <CommandGroup heading="Projects the app knows">
                    {options.map((k) => (
                      <CommandItem key={k} value={k} onSelect={() => add(k)}>
                        <span className="font-mono">{k}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {entries.length === 0 && (
        <span className="text-xs text-muted-foreground">
          None yet. Their ticket is searched for here when you wait on them.
        </span>
      )}
    </div>
  );
}

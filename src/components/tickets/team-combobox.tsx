/**
 * The Edit dialog's Team field (FR-17.5, D59): None, the teams on synced
 * tickets, and from two typed characters a search in Jira (best effort). A
 * current team without an id is shown but not offered.
 */
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
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
import { cn } from "@/lib/utils";
import { JiraClient } from "@/services/jira";
import { CURRENT_TEAM } from "@/services/tickets/edit";
import {
  syncedTeams,
  TEAM_SEARCH_MIN,
  type TeamOption,
  teamOptions,
} from "@/services/tickets/teams";

export function TeamCombobox({
  id,
  fieldId,
  value,
  currentName,
  onChange,
  open: dialogOpen,
}: {
  id: string;
  /** The Team field to search. */
  fieldId: string;
  /** The team's id, CURRENT_TEAM for a team without one, or empty for none. */
  value: string;
  /** The ticket's team name as cached, for a value no option names. */
  currentName: string | null;
  onChange: (value: string) => void;
  open: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  // Names of teams picked from a search, so the trigger can show them later.
  const [picked, setPicked] = useState<TeamOption | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const synced = useQuery({
    queryKey: queryKeys.syncedTeams,
    queryFn: ({ signal }) => run(syncedTeams, signal),
    enabled: dialogOpen,
  });
  const search = useQuery({
    queryKey: queryKeys.teamSearch(fieldId, debounced),
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(JiraClient, (j) => j.teamSuggestions(fieldId, debounced)),
        signal,
      ),
    enabled: open && debounced.length >= TEAM_SEARCH_MIN,
    staleTime: 60_000,
  });
  const searched = debounced.length >= TEAM_SEARCH_MIN && debounced === text.trim();
  const lists = teamOptions({
    synced: synced.data ?? [],
    text,
    search: searched && search.data ? search.data : null,
    searchFailed: searched && search.isError,
  });
  const name =
    value === CURRENT_TEAM
      ? currentName
      : value
        ? ([
            // Real names before a synced "Team <id>" placeholder.
            ...(picked ? [picked] : []),
            ...(search.data ?? []),
            ...lists.synced,
            ...(synced.data ?? []),
          ].find((t) => t.id === value)?.name ??
          currentName ??
          `Team ${value}`)
        : null;
  const pick = (team: TeamOption | null) => {
    if (team) setPicked(team);
    onChange(team?.id ?? "");
    setOpen(false);
    setText("");
  };
  const item = (t: TeamOption) => (
    <CommandItem key={t.id} value={`team ${t.id}`} onSelect={() => pick(t)}>
      <Check className={cn("size-4", t.id === value ? "opacity-100" : "opacity-0")} />
      <span className="truncate">{t.name}</span>
    </CommandItem>
  );
  // Modal, so the list scrolls inside the dialog (see IssueCombobox).
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !name && "text-muted-foreground")}>{name ?? "None"}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="min-w-(--radix-popover-trigger-width) p-0" align="start">
        {/* Jira and the code do the matching, so cmdk must not filter again. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search teams" value={text} onValueChange={setText} />
          <CommandList>
            <CommandEmpty>
              {searched && search.isPending ? "Searching..." : "No matching team."}
            </CommandEmpty>
            {!text.trim() && (
              <CommandGroup>
                <CommandItem value="__none__" onSelect={() => pick(null)}>
                  <Check className={cn("size-4", !value ? "opacity-100" : "opacity-0")} />
                  <span className="text-muted-foreground">None</span>
                </CommandItem>
              </CommandGroup>
            )}
            {lists.synced.length > 0 && (
              <CommandGroup heading="On your synced tickets">{lists.synced.map(item)}</CommandGroup>
            )}
            {lists.found.length > 0 && (
              <CommandGroup heading="In Jira">{lists.found.map(item)}</CommandGroup>
            )}
          </CommandList>
          {lists.note && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">{lists.note}</p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

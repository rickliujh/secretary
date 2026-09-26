import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Building2, Settings2, Ticket, UserRound } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { CONTEXT_NAV, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
import { usePeople, useTeams, useTicketRows } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { SETTINGS_TABS } from "@/app/settings-tabs";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { searchTicketKeys } from "@/services/tickets/queries";

const MAX_TICKETS = 20;

/** Ctrl/Cmd+K palette: pages, settings tabs, tickets, contacts and teams. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const q = useDeferredValue(input.trim());
  const rows = useTicketRows({ enabled: open });
  const keys = useQuery({
    queryKey: queryKeys.ticketSearch(q),
    queryFn: ({ signal }) => run(searchTicketKeys(q), signal),
    enabled: open && q.length >= 2,
  });
  const people = usePeople({ enabled: open });
  const teams = useTeams({ enabled: open });
  const tickets = useMemo(() => {
    if (!keys.data || !rows.data) return [];
    const byKey = new Map(rows.data.map((r) => [r.key, r]));
    return [...keys.data]
      .map((k) => byKey.get(k))
      .filter((r) => r !== undefined)
      .slice(0, MAX_TICKETS);
  }, [keys.data, rows.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Go to a page or search tickets..."
        value={input}
        onValueChange={setInput}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {tickets.length > 0 && (
          <CommandGroup heading="Tickets">
            {tickets.map((t) => (
              <CommandItem
                key={t.key}
                // Include the query so cmdk's own filter keeps full-text matches.
                value={`${t.key} ${t.summary} ${q}`}
                onSelect={() => go(() => navigate({ to: "/tickets", search: { key: t.key } }))}
              >
                <Ticket />
                <span className="font-mono text-xs">{t.key}</span>
                <span className="truncate">{t.summary}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {q.length >= 1 && (people.data?.length ?? 0) > 0 && (
          <CommandGroup heading="People">
            {(people.data ?? []).map((p) => (
              <CommandItem
                key={p.id}
                value={`person ${p.displayName} ${p.jiraUsername ?? ""} ${p.title ?? ""}`}
                onSelect={() => go(() => navigate({ to: "/people", search: { id: p.id } }))}
              >
                <UserRound />
                {p.displayName}
                {p.title && <span className="text-muted-foreground">{p.title}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {q.length >= 1 && (teams.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Teams">
            {(teams.data ?? []).map((t) => (
              <CommandItem
                key={t.id}
                value={`team ${t.name}`}
                onSelect={() => go(() => navigate({ to: "/teams", search: { id: t.id } }))}
              >
                <Building2 />
                {t.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Pages">
          {[...WORK_NAV, ...CONTEXT_NAV, SETTINGS_NAV].map((item) => (
            <CommandItem key={item.to} onSelect={() => go(() => navigate({ to: item.to }))}>
              <item.icon />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Settings">
          {SETTINGS_TABS.map((tab) => (
            <CommandItem
              key={tab.value}
              value={`settings ${tab.label}`}
              onSelect={() => go(() => navigate({ to: "/settings", search: { tab: tab.value } }))}
            >
              <Settings2 />
              {tab.label}
              <CommandShortcut>Settings</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Settings2, Ticket } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { CONTEXT_NAV, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
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
import { listTicketRows, searchTicketKeys } from "@/services/tickets/queries";

const MAX_TICKETS = 20;

/** Ctrl/Cmd+K palette. Later phases add tickets, contacts and inbox items. */
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
  const rows = useQuery({
    queryKey: queryKeys.ticketRows,
    queryFn: ({ signal }) => run(listTicketRows, signal),
    enabled: open,
  });
  const keys = useQuery({
    queryKey: queryKeys.ticketSearch(q),
    queryFn: ({ signal }) => run(searchTicketKeys(q), signal),
    enabled: open && q.length >= 2,
  });
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

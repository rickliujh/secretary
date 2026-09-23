import { useNavigate } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useEffect } from "react";
import { CONTEXT_NAV, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
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

/** Ctrl/Cmd+K palette. Later phases add tickets, contacts and inbox items. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();

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
      <CommandInput placeholder="Go to..." />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
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

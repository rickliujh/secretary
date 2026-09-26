import { Check, ChevronsUpDown, User, Users, X } from "lucide-react";
import { useState } from "react";
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
import { cn } from "@/lib/utils";
import type { Person } from "@/services/directory/queries";
import type { TicketRow } from "@/services/tickets/tree";

export type Recipient = { type: "person" | "team"; id: string } | null;

/** A contact or a team to write to (FR-6.1). */
export function RecipientPicker({
  people,
  teams,
  value,
  onChange,
  id,
}: {
  people: readonly Person[];
  teams: readonly { id: string; name: string; function: string | null }[];
  value: Recipient;
  onChange: (r: Recipient) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const label =
    value?.type === "person"
      ? people.find((p) => p.id === value.id)?.displayName
      : value?.type === "team"
        ? teams.find((t) => t.id === value.id)?.name
        : undefined;
  const pick = (r: Recipient) => {
    onChange(r);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !label && "text-muted-foreground")}>
            {label ?? "Choose a person or team"}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search contacts and teams" />
          <CommandList>
            <CommandEmpty>No match. Add contacts on the People page.</CommandEmpty>
            <CommandGroup heading="People">
              {people.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`person ${p.displayName} ${p.title ?? ""}`}
                  onSelect={() => pick({ type: "person", id: p.id })}
                >
                  <User className="size-4" />
                  {p.displayName}
                  {p.title && <span className="text-muted-foreground">{p.title}</span>}
                  <Check
                    className={cn(
                      "ml-auto size-4",
                      value?.type === "person" && value.id === p.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Teams">
              {teams.map((t) => (
                <CommandItem
                  key={t.id}
                  value={`team ${t.name} ${t.function ?? ""}`}
                  onSelect={() => pick({ type: "team", id: t.id })}
                >
                  <Users className="size-4" />
                  {t.name}
                  <Check
                    className={cn(
                      "ml-auto size-4",
                      value?.type === "team" && value.id === t.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Tickets the message is about; their facts ground the draft (FR-6.2). */
export function TicketPicker({
  tickets,
  value,
  onChange,
  id,
}: {
  tickets: readonly TicketRow[];
  value: string[];
  onChange: (keys: string[]) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (key: string) =>
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal text-muted-foreground"
          >
            Add tickets
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command>
            <CommandInput placeholder="Search by key or summary" />
            <CommandList>
              <CommandEmpty>No tickets.</CommandEmpty>
              <CommandGroup>
                {tickets.map((t) => (
                  <CommandItem
                    key={t.key}
                    value={`${t.key} ${t.summary}`}
                    onSelect={() => toggle(t.key)}
                  >
                    <Check
                      className={cn("size-4", value.includes(t.key) ? "opacity-100" : "opacity-0")}
                    />
                    <span className="font-mono text-xs">{t.key}</span>
                    <span className="truncate">{t.summary}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((k) => (
            <Badge key={k} variant="secondary" className="gap-1 font-mono">
              {k}
              <button type="button" aria-label={`Remove ${k}`} onClick={() => toggle(k)}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

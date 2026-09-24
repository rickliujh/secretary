import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
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

/** Optional "from" contact for an intake (FR-2.1). */
export function SenderPicker({
  people,
  value,
  onChange,
}: {
  people: readonly Person[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = people.find((p) => p.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="From"
          className="w-48 justify-between font-normal"
        >
          <span className="truncate">{selected ? selected.displayName : "From (optional)"}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search contacts" />
          <CommandList>
            <CommandEmpty>No contacts.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value="__clear"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  No sender
                </CommandItem>
              )}
              {people.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.displayName} ${p.title ?? ""}`}
                  onSelect={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", p.id === value ? "opacity-100" : "opacity-0")} />
                  {p.displayName}
                  {p.title && <span className="text-muted-foreground">{p.title}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

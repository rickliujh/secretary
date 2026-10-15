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

/** A key the user may type that is not in the list: a Jira key or a "$new:1" ref. */
const TYPED_KEY = /^([A-Z][A-Z0-9_]+-\d+|\$new:\d+)$/;

export type IssueOption = { value: string; label: string; hint?: string };

/**
 * Picks one ticket by key or summary. A key not in the list (a ticket outside the
 * synced scope, or an issue created earlier in the same thread) can be typed.
 */
export function IssueCombobox({
  id,
  value,
  onChange,
  options,
  placeholder = "Choose an issue",
  noneLabel = "None",
}: {
  id?: string;
  value: string;
  onChange: (key: string) => void;
  options: readonly IssueOption[];
  placeholder?: string;
  noneLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = options.find((o) => o.value === value);
  const typed = search
    .trim()
    .toUpperCase()
    .replace(/^\$NEW:/, "$new:");
  const offerTyped = TYPED_KEY.test(typed) && !options.some((o) => o.value === typed);
  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
    setSearch("");
  };
  // Modal, so the list scrolls inside a dialog: the popover is portaled outside the
  // dialog, whose scroll lock would otherwise swallow the wheel.
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          title={value ? [value, current?.label].filter(Boolean).join(" ") : undefined}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? (
              <>
                <span className="font-mono">{value}</span>
                {current && <span className="ml-2 text-muted-foreground">{current.label}</span>}
              </>
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      {/* Wider than a narrow trigger, so summaries are readable; hover shows the rest. */}
      <PopoverContent
        className="w-[min(36rem,calc(100vw-2rem))] min-w-(--radix-popover-trigger-width) p-0"
        align="start"
      >
        <Command>
          <CommandInput
            placeholder="Search by key or summary"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No matching issue. Type a full key to use it.</CommandEmpty>
            <CommandGroup>
              {offerTyped && (
                <CommandItem value={`use ${typed}`} onSelect={() => pick(typed)}>
                  Use <span className="font-mono">{typed}</span>
                </CommandItem>
              )}
              {value && (
                <CommandItem value="__none__ clear" onSelect={() => pick("")}>
                  <span className="text-muted-foreground">{noneLabel}</span>
                </CommandItem>
              )}
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.value} ${o.label}`}
                  title={`${o.value} ${o.label}`}
                  onSelect={() => pick(o.value)}
                >
                  <Check
                    className={cn("size-4", o.value === value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="shrink-0 whitespace-nowrap font-mono text-xs">{o.value}</span>
                  <span className="truncate">{o.label}</span>
                  {o.hint && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

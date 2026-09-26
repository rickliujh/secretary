import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarRange, ChevronDown, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { relativeTime, shortDate } from "@/lib/time";
import { type CachedBrief, MAX_BRIEF_DAYS } from "@/services/dashboard/brief";
import { useGenerateBrief } from "./use-dashboard";

const SECTIONS: [keyof CachedBrief["sections"], string][] = [
  ["doFirst", "Do first"],
  ["chase", "Chase"],
  ["changed", "What changed"],
];

const PRESETS: [number, string][] = [
  [1, "Since yesterday"],
  [3, "Last 3 days"],
  [7, "Last 7 days"],
  [14, "Last 14 days"],
];

const DaysForm = z.object({
  days: z.coerce
    .number<string>()
    .int("Whole days")
    .min(1, "At least 1")
    .max(MAX_BRIEF_DAYS, `At most ${MAX_BRIEF_DAYS}`),
});

function periodLabel(brief: CachedBrief) {
  if (!brief.days) return null;
  return brief.days === 1
    ? "Since yesterday"
    : `Last ${brief.days} days${brief.since ? ` (since ${shortDate(brief.since)})` : ""}`;
}

/** A brief over a chosen period (D37): presets, or any number of days. */
function PeriodPicker({ onPick, disabled }: { onPick: (days: number) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const form = useForm<z.input<typeof DaysForm>, unknown, z.output<typeof DaysForm>>({
    resolver: zodResolver(DaysForm),
    defaultValues: { days: "5" },
  });
  const pick = (days: number) => {
    setOpen(false);
    onPick(days);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} aria-label="Brief for a period">
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Catch up on a period</p>
        {PRESETS.map(([days, label]) => (
          <Button
            key={days}
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => pick(days)}
          >
            <CalendarRange /> {label}
          </Button>
        ))}
        <Separator className="my-1" />
        <form
          className="flex items-start gap-1 p-1"
          onSubmit={form.handleSubmit((v) => pick(v.days))}
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1 text-sm">
              Last
              <Input
                aria-label="Days"
                inputMode="numeric"
                className="h-7 w-14"
                {...form.register("days")}
              />
              days
            </div>
            {form.formState.errors.days && (
              <span className="text-xs text-destructive">{form.formState.errors.days.message}</span>
            )}
          </div>
          <Button type="submit" size="sm" variant="secondary" className="ml-auto">
            Write
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Daily brief (FR-5.4): generated on demand, kept until the data changes. */
export function BriefPanel({ brief, fresh }: { brief: CachedBrief | null; fresh: boolean }) {
  const generate = useGenerateBrief();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Brief</CardTitle>
        <CardDescription className="flex items-center gap-2">
          {brief ? (
            <>
              {periodLabel(brief) && <Badge variant="secondary">{periodLabel(brief)}</Badge>}
              <span>Written {relativeTime(brief.generatedAt)}</span>
              {brief.model && <span>· {brief.model}</span>}
              {!fresh && <Badge variant="outline">data changed since</Badge>}
            </>
          ) : (
            "A short summary of what changed, what to do first and who to chase."
          )}
        </CardDescription>
        <CardAction>
          <ButtonGroup>
            <Button
              size="sm"
              variant={brief && fresh ? "outline" : "default"}
              disabled={generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generate.isPending ? (
                <Loader2 className="animate-spin" />
              ) : brief ? (
                <RefreshCw />
              ) : (
                <Sparkles />
              )}
              {brief ? "Regenerate" : "Write brief"}
            </Button>
            <PeriodPicker disabled={generate.isPending} onPick={(days) => generate.mutate(days)} />
          </ButtonGroup>
        </CardAction>
      </CardHeader>
      {brief && (
        <CardContent className="grid gap-4 md:grid-cols-3">
          {SECTIONS.map(([key, title]) => (
            <section key={key}>
              <h3 className="mb-1 text-sm font-medium">{title}</h3>
              <Markdown linkTickets>{brief.sections[key]}</Markdown>
            </section>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

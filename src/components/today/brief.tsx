import { Loader2, NotebookText, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { relativeTime } from "@/lib/time";
import type { CachedBrief } from "@/services/dashboard/brief";
import { useGenerateBrief } from "./use-today";

const SECTIONS: [keyof CachedBrief["sections"], string][] = [
  ["doFirst", "Do first"],
  ["chase", "Chase"],
  ["changed", "What changed"],
];

/**
 * Daily brief (FR-5.4) behind a button on Today (D49): generated on demand,
 * kept until the data changes, read in a side panel.
 */
export function BriefButton({ brief, fresh }: { brief: CachedBrief | null; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const generate = useGenerateBrief();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <NotebookText /> Brief
        {brief && !fresh && (
          <>
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            <span className="sr-only">(data changed since)</span>
          </>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle>Brief</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-2">
              {brief ? (
                <>
                  <span>Written {relativeTime(brief.generatedAt)}</span>
                  {brief.model && <span>· {brief.model}</span>}
                  {!fresh && <Badge variant="outline">data changed since</Badge>}
                </>
              ) : (
                "A short summary of what changed, what to do first and who to chase."
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {brief ? (
              SECTIONS.map(([key, title]) => (
                <section key={key} className="min-w-0">
                  <h3 className="mb-1 text-sm font-medium">{title}</h3>
                  <Markdown linkTickets>{brief.sections[key]}</Markdown>
                </section>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No brief written yet.</p>
            )}
          </div>
          <SheetFooter className="border-t">
            <Button
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
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

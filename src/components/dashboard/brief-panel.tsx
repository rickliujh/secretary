import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { relativeTime } from "@/lib/time";
import type { CachedBrief } from "@/services/dashboard/brief";
import { useGenerateBrief } from "./use-dashboard";

const SECTIONS: [keyof CachedBrief["sections"], string][] = [
  ["doFirst", "Do first"],
  ["chase", "Chase"],
  ["changed", "What changed"],
];

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
              <span>Written {relativeTime(brief.generatedAt)}</span>
              {brief.model && <span>· {brief.model}</span>}
              {!fresh && <Badge variant="outline">data changed since</Badge>}
            </>
          ) : (
            "A short summary of what changed, what to do first and who to chase."
          )}
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={brief && fresh ? "ghost" : "default"}
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

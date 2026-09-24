import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Effect } from "effect";
import { ExternalLink, FileDown, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/time";
import { ConfluenceClient } from "@/services/confluence";
import { textToCql, webUrl } from "@/services/confluence/cql";
import { importConfluencePage } from "@/services/directory/notes";
import type { Subject } from "@/services/directory/schema";
import { jiraDateToIso } from "@/services/jira/dates";
import { useDirectoryMutation } from "./use-directory";

/** Search Confluence and import a page as a context note on `subject` (FR-4.4). */
export function ConfluenceImportDialog({
  subject,
  open,
  onOpenChange,
}: {
  subject: Subject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: settings } = useSettings();
  const [text, setText] = useState("");
  const [space, setSpace] = useState("");
  const [cqlMode, setCqlMode] = useState(false);
  const input = useDeferredValue(text.trim());
  const cql = cqlMode ? input || null : textToCql(input, space);

  const results = useQuery({
    queryKey: queryKeys.confluenceSearch(cql ?? ""),
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(ConfluenceClient, (c) =>
          Effect.map(c.search(cql ?? ""), (r) => ({
            ...r,
            base: r._links.base ?? settings?.confluence.baseUrl ?? "",
          })),
        ),
        signal,
      ),
    enabled: open && !!cql && input.length >= 2,
    placeholderData: (prev) => prev,
  });

  const importPage = useDirectoryMutation(
    (id: string) => importConfluencePage(id, subject),
    (r) => (r.replaced ? `Updated "${r.title}" (version ${r.version})` : `Imported "${r.title}"`),
  );

  const configured = !!settings?.confluence.baseUrl;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from Confluence</DialogTitle>
          <DialogDescription>
            The page is converted to Markdown and stored locally with its source link and version.
          </DialogDescription>
        </DialogHeader>
        {!configured ? (
          <p className="text-sm text-muted-foreground">
            Confluence is not connected.{" "}
            <Link
              to="/settings"
              search={{ tab: "confluence" }}
              className="underline"
              onClick={() => onOpenChange(false)}
            >
              Open Confluence settings
            </Link>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-60 flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                <Input
                  autoFocus
                  aria-label="Search Confluence"
                  placeholder={
                    cqlMode
                      ? 'CQL, e.g. space = "PAY" AND label = "team"'
                      : "Search titles and text"
                  }
                  className="pl-8 font-mono text-xs"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              {!cqlMode && (
                <Input
                  aria-label="Space key"
                  placeholder="Space"
                  className="w-24 font-mono text-xs uppercase"
                  value={space}
                  onChange={(e) => setSpace(e.target.value.toUpperCase())}
                />
              )}
              <div className="flex items-center gap-2">
                <Switch id="cql-mode" checked={cqlMode} onCheckedChange={setCqlMode} />
                <Label htmlFor="cql-mode" className="text-sm font-normal">
                  CQL
                </Label>
              </div>
            </div>
            <div className="max-h-96 min-h-24 overflow-y-auto">
              {results.isError && (
                <p className="text-sm text-destructive">
                  {String((results.error as Error).message)}
                </p>
              )}
              {results.data?.results.length === 0 && (
                <p className="text-sm text-muted-foreground">No pages found.</p>
              )}
              <ul className="flex flex-col divide-y">
                {(results.data?.results ?? []).map((r) => {
                  const url = webUrl(r._links, results.data?.base ?? "");
                  return (
                    <li key={r.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.space && (
                            <Badge variant="outline" className="mr-2 font-mono">
                              {r.space.key}
                            </Badge>
                          )}
                          {r.version?.when &&
                            `updated ${relativeTime(jiraDateToIso(r.version.when))}`}
                          {r.version && ` · v${r.version.number}`}
                        </p>
                      </div>
                      {url && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Open in browser"
                          onClick={() => void openUrl(url)}
                        >
                          <ExternalLink />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={importPage.isPending}
                        onClick={() => importPage.mutate(r.id)}
                      >
                        <FileDown /> Import
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

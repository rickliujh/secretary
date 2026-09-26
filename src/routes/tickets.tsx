import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ListTree, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { z } from "zod";
import { useSettings } from "@/app/hooks";
import { useTicketRows } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { runSync, useSyncStatus } from "@/app/sync";
import { PageHeader, Planned } from "@/components/page";
import { TicketSheet } from "@/components/tickets/ticket-sheet";
import { TicketTable } from "@/components/tickets/ticket-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { currentJiraUsername, searchTicketKeys } from "@/services/tickets/queries";
import {
  buildTree,
  isFiltering,
  type TicketFilters,
  type TicketRow,
} from "@/services/tickets/tree";

export const Route = createFileRoute("/tickets")({
  validateSearch: z.object({ key: z.string().optional() }),
  component: TicketsPage,
});

const ANY = "__any__";
const ME = "__me__";
const EMPTY: TicketRow[] = [];
type Category = TicketRow["statusCategory"];

function TicketsPage() {
  const { key } = Route.useSearch();
  const navigate = useNavigate({ from: "/tickets" });
  const { data: settings } = useSettings();
  const sync = useSyncStatus();

  const [text, setText] = useState("");
  const q = useDeferredValue(text.trim());
  const [categories, setCategories] = useState<Category[]>(["new", "indeterminate"]);
  const [assignee, setAssignee] = useState<string>(ANY);
  const [project, setProject] = useState<string>(ANY);
  const [showStale, setShowStale] = useState(false);
  const me = useQuery({
    queryKey: ["jira", "username"],
    queryFn: ({ signal }) => run(currentJiraUsername, signal),
  }).data;

  const rows = useTicketRows();
  const search = useQuery({
    queryKey: queryKeys.ticketSearch(q),
    queryFn: ({ signal }) => run(searchTicketKeys(q), signal),
    enabled: q.length > 0,
    placeholderData: (prev) => prev,
  });

  const data = rows.data ?? EMPTY;
  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data) if (r.assignee) map.set(r.assignee, r.assigneeDisplay ?? r.assignee);
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const projects = useMemo(() => [...new Set(data.map((r) => r.projectKey))].sort(), [data]);

  const filters = useMemo<TicketFilters>(
    () => ({
      textMatches: q ? (search.data ?? new Set()) : null,
      statusCategories: new Set(categories),
      assignee: assignee === ANY ? null : assignee === ME ? (me ?? null) : assignee,
      project: project === ANY ? null : project,
      showStale,
    }),
    [q, search.data, categories, assignee, me, project, showStale],
  );
  const tree = useMemo(() => buildTree(data, filters), [data, filters]);

  if (!settings?.jira.baseUrl) {
    return (
      <>
        <PageHeader title="Tickets" />
        <Planned
          icon={ListTree}
          title="Jira is not connected"
          description="Add your Jira base URL and personal access token in Settings, then sync."
        />
        <div className="mt-4 flex justify-center">
          <Button asChild>
            <Link to="/settings" search={{ tab: "jira" }}>
              Open Jira settings
            </Link>
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search tickets"
            placeholder="Search summary, description or key"
            className="pl-8"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          value={categories}
          onValueChange={(v) => setCategories(v as Category[])}
          aria-label="Status category"
        >
          <ToggleGroupItem value="new">To do</ToggleGroupItem>
          <ToggleGroupItem value="indeterminate">In progress</ToggleGroupItem>
          <ToggleGroupItem value="done">Done</ToggleGroupItem>
        </ToggleGroup>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger size="sm" className="w-44" aria-label="Assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any assignee</SelectItem>
            {me && <SelectItem value={ME}>Me</SelectItem>}
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {assignees.map(([name, display]) => (
              <SelectItem key={name} value={name}>
                {display}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger size="sm" className="w-36" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="show-stale" checked={showStale} onCheckedChange={setShowStale} />
          <Label htmlFor="show-stale" className="text-sm font-normal">
            Out of scope
          </Label>
        </div>
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {data.length} cached
        </span>
      </div>

      {rows.isSuccess && data.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
          <p>{sync?.running ? "Syncing for the first time..." : "Nothing cached yet."}</p>
          {!sync?.running && (
            <Button onClick={() => void runSync().catch(() => undefined)}>Sync now</Button>
          )}
        </div>
      ) : (
        <TicketTable
          nodes={tree}
          expandAll={isFiltering(filters) && (q.length > 0 || assignee !== ANY || project !== ANY)}
          selectedKey={key}
          onSelect={(k) => navigate({ search: { key: k } })}
        />
      )}
      <TicketSheet issueKey={key} onClose={() => navigate({ search: {} })} />
    </div>
  );
}

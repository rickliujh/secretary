import {
  columnSizingFeature,
  createColumnHelper,
  createExpandedRowModel,
  type ExpandedState,
  rowExpandingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime, shortDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TicketNode } from "@/services/tickets/tree";
import { StatusBadge } from "./status-badge";

const features = tableFeatures({
  columnSizingFeature,
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
});
const helper = createColumnHelper<typeof features, TicketNode>();

const ROW_HEIGHT = 36;

function defaultExpanded(nodes: TicketNode[]): Record<string, boolean> {
  return Object.fromEntries(nodes.filter((n) => n.isTrackedEpic).map((n) => [n.key, true]));
}

export function TicketTable({
  nodes,
  expandAll,
  selectedKey,
  onSelect,
}: {
  nodes: TicketNode[];
  /** True while filtering, so matches inside collapsed epics are visible. */
  expandAll: boolean;
  selectedKey: string | undefined;
  onSelect: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState<ExpandedState>(() => defaultExpanded(nodes));
  useEffect(() => {
    setExpanded((prev) => (expandAll ? true : prev === true ? defaultExpanded(nodes) : prev));
  }, [expandAll, nodes]);

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("key", {
          header: "Key",
          size: 170,
          cell: ({ row }) => (
            <div className="flex items-center gap-1" style={{ paddingLeft: row.depth * 16 }}>
              {row.getCanExpand() ? (
                <button
                  type="button"
                  aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    row.toggleExpanded();
                  }}
                >
                  <ChevronRight
                    className={cn(
                      "size-4 transition-transform",
                      row.getIsExpanded() && "rotate-90",
                    )}
                  />
                </button>
              ) : (
                <span className="inline-block w-5" />
              )}
              <span className="font-mono text-xs">{row.original.key}</span>
            </div>
          ),
        }),
        helper.accessor("summary", {
          header: "Summary",
          size: 420,
          cell: ({ row }) => (
            <span className="truncate">
              {row.original.issueType === "Epic" &&
              row.original.epicName &&
              row.original.epicName !== row.original.summary
                ? `${row.original.epicName}: ${row.original.summary}`
                : row.original.summary}
            </span>
          ),
        }),
        helper.accessor("issueType", { header: "Type", size: 90 }),
        helper.accessor("status", {
          header: "Status",
          size: 130,
          cell: ({ row }) => (
            <StatusBadge status={row.original.status} category={row.original.statusCategory} />
          ),
        }),
        helper.accessor("assigneeDisplay", {
          header: "Assignee",
          size: 140,
          cell: ({ getValue }) =>
            getValue() ?? <span className="text-muted-foreground">Unassigned</span>,
        }),
        helper.accessor("priority", { header: "Priority", size: 90 }),
        helper.accessor("dueDate", {
          header: "Due",
          size: 110,
          cell: ({ getValue }) => {
            const v = getValue();
            return v ? shortDate(v) : "";
          },
        }),
        helper.accessor("updated", {
          header: "Updated",
          size: 120,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{relativeTime(getValue())}</span>
          ),
        }),
      ]),
    [],
  );

  const table = useTable({
    features,
    columns,
    data: nodes,
    getSubRows: (n) => (n.children.length ? n.children : undefined),
    getRowId: (n) => n.key,
    state: { expanded },
    onExpandedChange: setExpanded,
  });

  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rows[i]?.id ?? i,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-lg border">
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-background">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} style={{ width: header.getSize() }}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {padTop > 0 && (
            <tr>
              <td style={{ height: padTop }} colSpan={columns.length} />
            </tr>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <TableRow
                key={row.id}
                data-state={row.original.key === selectedKey ? "selected" : undefined}
                className={cn(
                  "cursor-pointer",
                  !row.original.matched && "opacity-60",
                  row.original.stale && "italic",
                )}
                style={{ height: ROW_HEIGHT }}
                tabIndex={0}
                onClick={() => onSelect(row.original.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.original.key);
                  if (e.key === "ArrowRight" && row.getCanExpand()) row.toggleExpanded(true);
                  if (e.key === "ArrowLeft" && row.getCanExpand()) row.toggleExpanded(false);
                }}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className="truncate py-1">
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
          {padBottom > 0 && (
            <tr>
              <td style={{ height: padBottom }} colSpan={columns.length} />
            </tr>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

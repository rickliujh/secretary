/**
 * What the note shows at a block (FR-20.7, D67): the one-line strip under a
 * block that led to a conversation or a work item note, and the mark's menu
 * in the margin. Both are rendered by the page into the editor's DOM nodes.
 */
import { Link } from "@tanstack/react-router";
import {
  Check,
  CircleDashed,
  Inbox,
  Loader2,
  Lock,
  MessageSquare,
  PanelRightOpen,
  PencilLine,
  Sparkles,
  StickyNote,
} from "lucide-react";
import { memo } from "react";
import { TicketLink } from "@/components/tickets/ticket-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { stripBadge, stripWaits, type ThreadSummary } from "@/services/note/cards";
import type { BlockMark, MarkStatus } from "./block-marks";

/** The keyboard way to a line's menu, for titles and the page's hint. */
export const MENU_SHORTCUT = "Ctrl+. (⌘. on a Mac)";

const CHANGED = "changed, not read yet";

/** Under a block with a conversation: what waits, the summary, its tickets, Open. */
export const ThreadStrip = memo(function ThreadStrip({
  thread,
  changed,
  onOpen,
}: {
  thread: ThreadSummary;
  /** The block was edited since it was read. */
  changed: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex h-full items-center gap-2 font-sans text-xs text-muted-foreground">
      <Badge
        variant={stripWaits(thread) ? "default" : "secondary"}
        className="shrink-0 cursor-pointer"
        asChild
      >
        <button type="button" onClick={() => onOpen(thread.id)}>
          {stripBadge(thread)}
        </button>
      </Badge>
      {changed && (
        <Badge variant="outline" className="shrink-0">
          {CHANGED}
        </Badge>
      )}
      <span className="min-w-0 truncate">{thread.summary ?? "Reading..."}</span>
      {thread.created.map((k) => (
        <TicketLink key={k} ticketKey={k} className="shrink-0" />
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto h-6 shrink-0 px-2 text-xs"
        title={`Open the conversation; ${MENU_SHORTCUT} on the line opens its menu`}
        onClick={() => onOpen(thread.id)}
      >
        <PanelRightOpen className="size-3.5" />
        Open
      </Button>
    </div>
  );
});

/** Under a block noted on a work item. */
export const ContextStrip = memo(function ContextStrip({
  name,
  changed,
}: {
  name: string | null;
  changed: boolean;
}) {
  return (
    <div className="flex h-full items-center gap-1.5 font-sans text-xs text-muted-foreground">
      <StickyNote className="size-3.5 shrink-0" />
      <span className="truncate">
        Noted on {name ?? "a work item"}
        {changed ? ` · ${CHANGED}` : ""}
      </span>
    </div>
  );
});

const MARK: Record<MarkStatus, { icon: typeof Check; label: string; className: string }> = {
  acted: { icon: MessageSquare, label: "Led to a conversation", className: "text-primary" },
  revised: { icon: MessageSquare, label: "Led to a conversation", className: "text-primary" },
  context: { icon: StickyNote, label: "Noted on a work item", className: "text-sky-600" },
  skipped: { icon: Check, label: "Read: nothing to do", className: "text-muted-foreground" },
  private: { icon: Lock, label: "Private: never sent", className: "text-muted-foreground" },
  unread: {
    icon: CircleDashed,
    label: "Not read yet",
    // No mark until the pointer or the keyboard is on it: only its menu, for Ask.
    className: "text-muted-foreground opacity-0 hover:opacity-100 focus-visible:opacity-100",
  },
};

/**
 * The mark in the margin and its menu: Open and Open in Inbox for a block with
 * a conversation; "Ask the secretary about this" for one without that is not
 * private. Opened by a click or by Mod-. on the line (`open`).
 */
export const BlockMarkMenu = memo(function BlockMarkMenu({
  mark,
  open,
  onOpenChange,
  asking,
  askBusy,
  onOpen,
  onAsk,
  onCloseFocus,
}: {
  mark: BlockMark;
  open: boolean;
  onOpenChange: (key: string, open: boolean) => void;
  /** Ask runs on this block. */
  asking: boolean;
  /** Ask runs on some block: one at a time. */
  askBusy: boolean;
  onOpen: (thread: string) => void;
  onAsk: (hash: string) => void;
  /** When the menu closes: may send the focus elsewhere than the trigger (preventDefault). */
  onCloseFocus: (e: Event) => void;
}) {
  const look = MARK[mark.status];
  const Icon = asking ? Loader2 : mark.changed ? PencilLine : look.icon;
  const label = mark.changed ? `${look.label}; ${CHANGED}` : look.label;
  return (
    <DropdownMenu open={open} onOpenChange={(o) => onOpenChange(mark.key, o)}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: actions for this line`}
          title={`${label}. ${MENU_SHORTCUT} on the line opens this menu.`}
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            look.className,
            mark.waits && "text-amber-600",
            (asking || open) && "opacity-100",
          )}
        >
          <Icon className={cn("size-3.5", asking && "animate-spin")} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="font-sans" onCloseAutoFocus={onCloseFocus}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {mark.status === "context" && mark.row?.workItemName
            ? `Noted on ${mark.row.workItemName}`
            : label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {mark.thread ? (
          <>
            <DropdownMenuItem onSelect={() => mark.thread && onOpen(mark.thread)}>
              <PanelRightOpen /> Open
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/inbox" search={{ item: mark.thread }}>
                <Inbox /> Open in Inbox
              </Link>
            </DropdownMenuItem>
          </>
        ) : mark.private ? (
          <DropdownMenuItem disabled>
            <Lock /> Under your private heading: never sent
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={askBusy} onSelect={() => onAsk(mark.hash)}>
            <Sparkles /> Ask the secretary about this
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

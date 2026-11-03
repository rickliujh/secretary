import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useTicketRows } from "@/app/queries";
import { TicketLink } from "@/components/tickets/ticket-link";
import { cn } from "@/lib/utils";
import { markdownComponents, markdownPlugins, markdownUrlTransform } from "./markdown-options";

/**
 * Markdown for notes, drafts, briefs and chat. Raw HTML is not rendered; web
 * links open externally. With `linkTickets`, keys of synced tickets become links
 * that open the ticket in the app. With `linksAsText` (a page quoting other
 * people's words, D63), no other link is clickable and no image loads.
 */
export function Markdown({
  children,
  className,
  linkTickets = false,
  linksAsText = false,
}: {
  children: string;
  className?: string;
  linkTickets?: boolean;
  linksAsText?: boolean;
}) {
  const rows = useTicketRows({ enabled: linkTickets });
  const plugins = useMemo(
    () => markdownPlugins(linkTickets && rows.data ? new Set(rows.data.map((r) => r.key)) : null),
    [linkTickets, rows.data],
  );
  const components = useMemo(
    () =>
      markdownComponents({
        linksAsText,
        renderTicket: (key, text) => (
          <TicketLink ticketKey={key} className="font-mono">
            {text}
          </TicketLink>
        ),
        openExternal: (href) => void openUrl(href),
      }),
    [linksAsText],
  );
  return (
    <div className={cn("rich-content text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

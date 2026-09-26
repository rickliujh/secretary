import { Link } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTicketRows } from "@/app/queries";
import { remarkIssueLinks, TICKET_URL_PREFIX, ticketOfUrl } from "@/lib/issue-links";
import { cn } from "@/lib/utils";

/**
 * Markdown for notes, drafts, briefs and chat. Raw HTML is not rendered; web
 * links open externally. With `linkTickets`, keys of synced tickets become links
 * that open the ticket in the app.
 */
export function Markdown({
  children,
  className,
  linkTickets = false,
}: {
  children: string;
  className?: string;
  linkTickets?: boolean;
}) {
  const rows = useTicketRows({ enabled: linkTickets });
  const plugins = useMemo(() => {
    if (!linkTickets || !rows.data) return [remarkGfm];
    return [remarkGfm, remarkIssueLinks(new Set(rows.data.map((r) => r.key)))];
  }, [linkTickets, rows.data]);
  return (
    <div className={cn("rich-content text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={(url) => (url.startsWith(TICKET_URL_PREFIX) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children: text }) => {
            const key = ticketOfUrl(href);
            if (key)
              return (
                <Link to="/tickets" search={{ key }} className="font-mono">
                  {text}
                </Link>
              );
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) void openUrl(href);
                }}
              >
                {text}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

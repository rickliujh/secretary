/**
 * How `Markdown` renders links and images, kept free of the app's runtime so a
 * test can render with exactly these options. With `linksAsText` (pages that
 * quote other people's words, D63), every link that is no ticket link is
 * plain text, GFM autolinks included, and an image is its alt text.
 */
import type { ReactNode } from "react";
import { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkIssueLinks, TICKET_URL_PREFIX, ticketOfUrl } from "@/lib/issue-links";

export type MarkdownLinkOptions = {
  /** Render non-ticket links as text and images as their alt text. */
  linksAsText?: boolean;
  /** A ticket link, as the app shows it. */
  renderTicket: (key: string, children: ReactNode) => ReactNode;
  /** Opens a web link outside the app. */
  openExternal: (href: string) => void;
};

export function markdownPlugins(knownTickets: ReadonlySet<string> | null) {
  return knownTickets ? [remarkGfm, remarkIssueLinks(knownTickets)] : [remarkGfm];
}

export const markdownUrlTransform = (url: string) =>
  url.startsWith(TICKET_URL_PREFIX) ? url : defaultUrlTransform(url);

export function markdownComponents(o: MarkdownLinkOptions): Components {
  return {
    a: ({ href, children }) => {
      const key = ticketOfUrl(href);
      if (key) return o.renderTicket(key, children);
      if (o.linksAsText) return <span>{children}</span>;
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href) o.openExternal(href);
          }}
        >
          {children}
        </a>
      );
    },
    ...(o.linksAsText ? { img: ({ alt }) => <span>{alt ?? ""}</span> } : {}),
  };
}

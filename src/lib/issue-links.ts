/**
 * Ticket keys in rendered Markdown become links to the ticket in the app
 * (briefs, chat answers). Only keys of synced tickets are linked, so text such
 * as "UTF-8" or "ISO-8601" is left alone; code and existing links are skipped.
 */
import { findAndReplace } from "mdast-util-find-and-replace";

export const TICKET_URL_PREFIX = "ticket:";
const KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

type Root = Parameters<typeof findAndReplace>[0];

export function remarkIssueLinks(known: ReadonlySet<string>) {
  return () => (tree: Root) => {
    findAndReplace(
      tree,
      [
        KEY,
        (key: string) =>
          known.has(key)
            ? {
                type: "link",
                url: `${TICKET_URL_PREFIX}${key}`,
                children: [{ type: "text", value: key }],
              }
            : false,
      ],
      { ignore: ["link", "linkReference", "code", "inlineCode"] },
    );
  };
}

/** The ticket key of a link made by `remarkIssueLinks`, or null. */
export const ticketOfUrl = (url: string | undefined) =>
  url?.startsWith(TICKET_URL_PREFIX) ? url.slice(TICKET_URL_PREFIX.length) : null;

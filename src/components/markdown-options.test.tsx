/**
 * The end-of-day page as the Inbox renders it (D63): the app's own
 * react-markdown options with `linksAsText`, over a page quoting someone who
 * wrote URLs, a www. host, an email and an image. Only ticket links are links.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { dayEnd } from "@/services/work/dayend";
import { markdownComponents, markdownPlugins, markdownUrlTransform } from "./markdown-options";

const NASTY =
  "See https://evil.example/p.png and www.evil.example/x, mail bob@evil.example ![x](https://evil.example/i.png) [y](https://evil.example/l) <https://evil.example/a>";

const render = (md: string, linksAsText: boolean) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={markdownPlugins(new Set(["PAY-12"]))}
      urlTransform={markdownUrlTransform}
      components={markdownComponents({
        linksAsText,
        renderTicket: (key, children) => (
          <a href={`ticket:${key}`} data-ticket={key}>
            {children}
          </a>
        ),
        openExternal: () => undefined,
      })}
    >
      {md}
    </ReactMarkdown>,
  );

const page = dayEnd({
  today: "2026-10-16",
  now: "2026-10-16T16:30:00.000Z",
  items: [{ id: "cert", name: "Renew the cert", current: false, state: null, needsLook: false }],
  events: [
    {
      itemId: "cert",
      kind: "jira_comment",
      at: "2026-10-16T10:00:00.000Z",
      time: "10:00",
      actor: "Ana Bell",
      summary: "Ana Bell commented on PAY-12",
      text: NASTY,
      ownWords: false,
      mine: false,
    },
  ],
  facts: new Map(),
  drafts: [],
  cards: [],
  questions: [],
});

describe("the end-of-day page rendered (D63)", () => {
  test("no link but ticket links, and no image", () => {
    const html = render(page.markdown, true);
    expect(html.match(/<a\b[^>]*>/g) ?? []).toEqual([
      '<a href="ticket:PAY-12" data-ticket="PAY-12">',
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="https://evil');
    expect(html).toContain("evil.example");
  });

  test("the escapes alone already stop GFM's autolinks", () => {
    const html = render(page.markdown, false);
    expect(html.match(/<a\b[^>]*>/g) ?? []).toEqual([
      '<a href="ticket:PAY-12" data-ticket="PAY-12">',
    ]);
  });

  test("text-only mode holds even without the page's escapes", () => {
    const html = render(NASTY, true);
    expect(html.match(/<a\b[^>]*>/g) ?? []).toEqual([]);
    expect(html).not.toContain("<img");
    // The default mode does link them: the mode is what stops it.
    expect(render(NASTY, false)).toContain('href="https://evil.example/p.png"');
  });
});

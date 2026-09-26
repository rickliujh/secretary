/**
 * Confluence storage format (XHTML with `ac:`/`ri:` macros) -> Markdown for
 * context notes (FR-4.4), using turndown with the GFM plugin.
 *
 * HTML parsers mishandle two storage-format features, so a pre-pass fixes them:
 * CDATA code bodies become escaped text, and self-closing `ac:`/`ri:` tags get
 * explicit end tags (otherwise the parser nests following content inside them).
 */
import { gfm } from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export function preprocessStorage(storage: string): string {
  return (
    storage
      // Code bodies: keep text verbatim; <pre> stops turndown collapsing whitespace.
      .replace(
        /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/g,
        (_m, text: string) =>
          `<ac:plain-text-body><pre>${escapeHtml(text)}</pre></ac:plain-text-body>`,
      )
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, text: string) => escapeHtml(text))
      // Elements with no text of their own become text here: a paragraph holding
      // only an image would otherwise count as blank and be dropped by turndown.
      .replace(/<ac:image\b[^>]*>([\s\S]*?)<\/ac:image>/g, (_m, inner: string) => {
        const name =
          /ri:filename="([^"]*)"/.exec(inner)?.[1] ?? /ri:value="([^"]*)"/.exec(inner)?.[1];
        return `(image: ${name || "embedded"})`;
      })
      .replace(/<ac:link>\s*<ri:user\b[^>]*?(?:\/>|>\s*<\/ri:user>)\s*<\/ac:link>/g, "@user")
      .replace(/<time\b[^>]*\bdatetime="([^"]*)"[^>]*?(?:\/>|>\s*<\/time>)/g, "$1")
      // `<x/>` is only self-closing in XML; an HTML parser would nest what follows inside it.
      .replace(/<([a-zA-Z][\w:-]*)(\s[^>]*?)?\s*\/>/g, (m, name: string, attrs = "") =>
        VOID_ELEMENTS.has(name.toLowerCase()) ? m : `<${name}${attrs}></${name}>`,
      )
  );
}

type El = HTMLElement;

const PANEL_LABELS: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  tip: "Tip",
  panel: "",
};
const DROPPED_MACROS = new Set([
  "toc",
  "children",
  "pagetree",
  "anchor",
  "recently-updated",
  "livesearch",
  "contentbylabel",
]);

const tag = (node: Node) => node.nodeName.toLowerCase();
const attr = (node: Node, name: string) => (node as El).getAttribute?.(name) ?? "";
const childrenByTag = (node: Node, name: string) =>
  Array.from(node.childNodes).filter((c) => tag(c) === name) as El[];
const param = (macro: Node, name: string) =>
  childrenByTag(macro, "ac:parameter")
    .find((p) => attr(p, "ac:name") === name)
    ?.textContent?.trim() ?? "";

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

export function storageToMarkdown(storage: string, opts: { baseUrl?: string } = {}): string {
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");
  // Elements that are often empty but still carry meaning. turndown sends blank
  // nodes to `blankReplacement` instead of the rules, so route them here too.
  const meaningfulWhenEmpty: Record<string, (node: Node) => string> = {};
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    blankReplacement: (_content, node) => {
      const handler = meaningfulWhenEmpty[tag(node)];
      if (handler) return handler(node);
      return (node as unknown as { isBlock?: boolean }).isBlock ? "\n\n" : "";
    },
  });
  td.use(gfm);

  td.addRule("list-item", {
    filter: "li",
    replacement: (content, node) => {
      const parent = node.parentNode as El | null;
      let prefix = "- ";
      if (parent && tag(parent) === "ol") {
        const start = Number(parent.getAttribute("start") ?? 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      return `${prefix}${body}${node.nextSibling && !/\n$/.test(body) ? "\n" : ""}`;
    },
  });

  td.addRule("ac-parameter", { filter: (n) => tag(n) === "ac:parameter", replacement: () => "" });
  td.addRule("ac-dropped", {
    filter: (n) =>
      ["ac:emoticon", "ac:placeholder", "ac:inline-comment-marker-ref"].includes(tag(n)),
    replacement: () => "",
  });

  td.addRule("ac-macro", {
    filter: (n) => tag(n) === "ac:structured-macro" || tag(n) === "ac:macro",
    replacement: (content, node) => {
      const name = attr(node, "ac:name");
      if (name === "code" || name === "noformat") {
        const body = childrenByTag(node, "ac:plain-text-body")[0]?.textContent ?? "";
        return `\n\n\`\`\`${param(node, "language")}\n${body.replace(/\n$/, "")}\n\`\`\`\n\n`;
      }
      if (name in PANEL_LABELS) {
        const title = param(node, "title");
        const label = [PANEL_LABELS[name], title].filter(Boolean).join(": ");
        return `\n\n${quote(`${label ? `**${label}**\n\n` : ""}${content.trim()}`)}\n\n`;
      }
      if (name === "expand") {
        const title = param(node, "title");
        return `\n\n${title ? `**${title}**\n\n` : ""}${content.trim()}\n\n`;
      }
      if (name === "status") return `[${param(node, "title") || "status"}]`;
      if (name === "jira") return param(node, "key") || content;
      if (DROPPED_MACROS.has(name)) return "";
      return content;
    },
  });

  const link = (content: string, node: Node) => {
    const body =
      childrenByTag(node, "ac:plain-text-link-body")[0]?.textContent?.trim() ||
      childrenByTag(node, "ac:link-body")[0]?.textContent?.trim();
    const page = childrenByTag(node, "ri:page")[0];
    const user = childrenByTag(node, "ri:user")[0];
    const attachment = childrenByTag(node, "ri:attachment")[0];
    if (body) return body;
    if (page) return attr(page, "ri:content-title");
    if (user) return "@user";
    if (attachment) return attr(attachment, "ri:filename");
    return content;
  };
  td.addRule("ac-link", { filter: (n) => tag(n) === "ac:link", replacement: link });
  meaningfulWhenEmpty["ac:link"] = (node) => link("", node);

  const image = (node: Node) => {
    const file = attr(childrenByTag(node, "ri:attachment")[0] ?? node, "ri:filename");
    const url = attr(childrenByTag(node, "ri:url")[0] ?? node, "ri:value");
    return `(image: ${file || url || "embedded"})`;
  };
  td.addRule("ac-image", {
    filter: (n) => tag(n) === "ac:image",
    replacement: (_c, node) => image(node),
  });
  meaningfulWhenEmpty["ac:image"] = image;

  td.addRule("ac-task-list", {
    filter: (n) => tag(n) === "ac:task-list",
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  td.addRule("ac-task", {
    filter: (n) => tag(n) === "ac:task",
    replacement: (_content, node) => {
      const done = childrenByTag(node, "ac:task-status")[0]?.textContent?.trim() === "complete";
      const body = childrenByTag(node, "ac:task-body")[0]?.textContent?.trim() ?? "";
      return `- [${done ? "x" : " "}] ${body}\n`;
    },
  });

  td.addRule("time", {
    filter: (n) => tag(n) === "time",
    replacement: (content, node) => attr(node, "datetime") || content,
  });
  meaningfulWhenEmpty.time = (node) => attr(node, "datetime");

  td.addRule("relative-link", {
    filter: (n) => tag(n) === "a" && attr(n, "href").startsWith("/"),
    replacement: (content, node) => `[${content}](${base}${attr(node, "href")})`,
  });

  return td
    .turndown(preprocessStorage(storage))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

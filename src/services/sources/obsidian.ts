/**
 * Pure parsing of one Obsidian note (design.md D41): YAML frontmatter, title,
 * aliases, tags (frontmatter and inline) and links ([[wikilinks]], embeds and
 * Markdown links to local notes). Code spans and fenced blocks are parsed with
 * mdast so tags and links inside code are ignored.
 */
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument } from "yaml";

export type ParsedNote = {
  title: string;
  aliases: string[];
  tags: string[];
  /** Link targets without heading, block or alias parts, e.g. "Projects/Ledger export". */
  links: string[];
  frontmatter: Record<string, unknown> | null;
  /** Markdown without the frontmatter. */
  body: string;
};

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Splits YAML frontmatter off the text. Invalid YAML counts as no frontmatter. */
export function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const m = FRONTMATTER.exec(text);
  if (!m) return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
  let data: unknown;
  try {
    // `parse` with logLevel "silent" swallows errors too, so check the document.
    const doc = parseDocument(m[1] ?? "", { uniqueKeys: false });
    if (doc.errors.length > 0) return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
    data = doc.toJS();
  } catch {
    return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
  }
  const frontmatter =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  return { frontmatter, body: text.slice(m[0].length) };
}

const dedupe = (values: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
};

/** A frontmatter value as strings: a list of scalars, or one scalar. */
const scalars = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.filter((v) => typeof v === "string" || typeof v === "number").map((v) => String(v));
};

const fileTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "") || path;

/** A tag without `#` and outer slashes, lower-cased; null when Obsidian would not treat it as one. */
export function normalizeTag(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/^#+/, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!tag || !/^[\p{L}\p{N}_/-]+$/u.test(tag)) return null;
  // At least one character that is not a digit (#1984 is not a tag).
  return /[^\d/]/.test(tag) ? tag : null;
}

const INLINE_TAG = /(?<=^|\s)#([\p{L}\p{N}_/-]+)/gu;
const WIKILINK = /!?\[\[([^[\]\n]+?)\]\]/g;
/** Embeds and links to attachments are not notes. */
const ATTACHMENT =
  /\.(png|jpe?g|gif|svg|webp|bmp|avif|pdf|mp3|mp4|m4a|wav|ogg|webm|mov|mkv|flac|canvas|excalidraw|base)$/i;

/** "Target" from the inside of [[Target#Heading^block|alias]]; null for same-note links. */
export function wikilinkTarget(inner: string): string | null {
  const target = inner
    .split("|")[0]
    .split("#")[0]
    .split("^")[0]
    .replace(/\\$/, "") // [[Target\|alias]] inside a table
    .trim()
    .replace(/\.md$/i, "");
  return target && !ATTACHMENT.test(target) ? target : null;
}

/** Resolves ./ and ../ against the note's folder; other paths are vault-relative as written. */
function resolveRelative(notePath: string, target: string): string {
  if (!/^\.\.?\//.test(target)) return target.replace(/^\/+/, "");
  const parts = notePath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/** A note path from a Markdown link destination, or null for URLs, anchors and non-notes. */
export function markdownLinkTarget(notePath: string, url: string): string | null {
  if (!url || url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  let path = url.split(/[#?]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep as written
  }
  if (!/\.md$/i.test(path)) return null;
  const resolved = resolveRelative(notePath, path.replace(/\.md$/i, ""));
  return resolved || null;
}

/**
 * Blanks code (fenced, indented, inline) and HTML comments, keeping offsets, and
 * collects Markdown link destinations.
 */
function scanMarkdown(body: string): { masked: string; urls: string[] } {
  const tree = fromMarkdown(body);
  const ranges: [number, number][] = [];
  const urls: string[] = [];
  const visit = (node: Nodes) => {
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      (node.type === "html" && node.value.startsWith("<!--"))
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      return;
    }
    if (node.type === "link" || node.type === "definition") urls.push(node.url);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  if (ranges.length === 0) return { masked: body, urls };
  let masked = "";
  let at = 0;
  for (const [start, end] of ranges) {
    masked += body.slice(at, start) + body.slice(start, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return { masked: masked + body.slice(at), urls };
}

/** Every string in a frontmatter value, for links in properties like `owner: "[[Dana]]"`. */
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

/** Parses one note. `path` is vault-relative with forward slashes. */
export function parseNote(path: string, text: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = frontmatter ?? {};

  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : fileTitle(path);

  const aliases = dedupe(
    [...scalars(fm.aliases), ...scalars(fm.alias)]
      .flatMap((a) => a.split(","))
      .map((a) => a.trim())
      .filter(Boolean),
  );

  const { masked, urls } = scanMarkdown(body);

  const tags = [...scalars(fm.tags), ...scalars(fm.tag)]
    .flatMap((t) => t.split(/[,\s]+/))
    .concat([...masked.matchAll(INLINE_TAG)].map((m) => m[1]))
    .map(normalizeTag)
    .filter((t): t is string => t !== null);

  const links = [
    ...[...strings(fm).join("\n").matchAll(WIKILINK)].map((m) => wikilinkTarget(m[1])),
    ...[...masked.matchAll(WIKILINK)].map((m) => wikilinkTarget(m[1])),
    ...urls.map((u) => markdownLinkTarget(path, u)),
  ].filter((l): l is string => l !== null);

  return {
    title,
    aliases,
    tags: [...new Set(tags)],
    links: dedupe(links),
    frontmatter,
    body,
  };
}

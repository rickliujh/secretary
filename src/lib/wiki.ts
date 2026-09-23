/**
 * Markdown <-> Jira wiki markup (design.md D14). jira2md does the conversion; a
 * small pre-pass fixes two gaps it has: dash/plus bullet lists and GFM tables.
 * Fenced code blocks are left untouched by the pre-pass.
 */
import j2m from "jira2md";

const FENCE = /^(```|~~~)/;

/** Splits text into alternating [prose, code, prose, ...] segments on fenced blocks. */
function splitFences(md: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let buf: string[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (FENCE.test(line.trim())) {
      if (!inCode) {
        out.push({ code: false, text: buf.join("\n") });
        buf = [line];
        inCode = true;
      } else {
        buf.push(line);
        out.push({ code: true, text: buf.join("\n") });
        buf = [];
        inCode = false;
      }
      continue;
    }
    buf.push(line);
  }
  out.push({ code: inCode, text: buf.join("\n") });
  return out.filter((s) => s.text.length > 0 || !s.code);
}

/** `- item` / `+ item` bullets become `*` bullets; nesting follows indentation (2 spaces per level). */
function normaliseBullets(text: string): string {
  return text.replace(/^([ \t]*)[-+][ \t]+/gm, (_m, indent: string) => {
    const width = indent.replace(/\t/g, "    ").length;
    return `${"  ".repeat(Math.floor(width / 2))}* `;
  });
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** GFM tables become wiki tables: `||h1||h2||` header, `|c1|c2|` rows. */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(next)) {
      out.push(`||${cells(line).join("||")}||`);
      i += 1;
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1] ?? "")) {
        i += 1;
        out.push(`|${cells(lines[i] ?? "").join("|")}|`);
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Wiki table rows start with `|`; protect them from jira2md, which would treat
// `||` or `|x|` inside a line as ordinary text but can mangle `*` and `_` in cells.
export function markdownToWiki(markdown: string): string {
  const normalised = markdown.replace(/\r\n/g, "\n");
  return splitFences(normalised)
    .map((segment) => {
      if (segment.code) return j2m.to_jira(segment.text);
      const prepared = normaliseBullets(convertTables(segment.text));
      return j2m.to_jira(prepared);
    })
    .join("\n")
    .trim();
}

export function wikiToMarkdown(wiki: string): string {
  return j2m.to_markdown(wiki.replace(/\r\n/g, "\n")).trim();
}

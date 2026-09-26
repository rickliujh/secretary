/**
 * Reading what the Obsidian CLI prints (D41). The formats come from Obsidian's
 * own handlers: JSON when asked with format=json, plain text otherwise, and
 * errors or empty results as plain text on stdout.
 */
import { parseDocument } from "yaml";
import { z } from "zod";
import { SourceError } from ".";

/** `search:context format=json`: every matching file with its matching lines. */
const SearchResultSchema = z.array(
  z.object({
    file: z.string(),
    matches: z.array(z.object({ line: z.number(), text: z.string() })).default([]),
  }),
);
export type CliSearchResult = z.infer<typeof SearchResultSchema>[number];

/** Messages Obsidian prints instead of a result when there is nothing to show. */
const EMPTY = /^No (matches|backlinks|tags|aliases|links|files|vaults) found\.$/;

/**
 * The error the output stands for, or null when it is a result. Obsidian
 * reports failures as text ("Error: File \"x\" not found.", "Vault not found.").
 */
export function cliError(stdout: string, code: number | null): SourceError | null {
  const text = stdout.trim();
  if (/Command line interface is not enabled/i.test(text))
    return new SourceError({
      kind: "unavailable",
      message:
        "Obsidian's command line interface is off. Turn it on in Obsidian: Settings > General > Advanced > Command line interface.",
    });
  if (text === "Vault not found.")
    return new SourceError({
      kind: "not_found",
      message: "Obsidian does not know this vault. Check its name in Settings > Data sources.",
    });
  const error = /^Error: ([\s\S]*)$/.exec(text);
  if (error) {
    const message = (error[1] ?? "").trim();
    return new SourceError({
      kind: /not found\.?$/i.test(message) ? "not_found" : "unavailable",
      message,
    });
  }
  if (code !== null && code !== 0 && !EMPTY.test(text))
    return new SourceError({
      kind: "unavailable",
      message: text || `The obsidian command failed (exit code ${code}).`,
    });
  return null;
}

const parseJson = <T>(schema: z.ZodType<T>, stdout: string, what: string): T => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new SourceError({
      kind: "unavailable",
      message: `Obsidian answered ${what} with text instead of JSON: ${stdout.trim().slice(0, 200)}`,
    });
  }
  const r = schema.safeParse(value);
  if (!r.success)
    throw new SourceError({
      kind: "unavailable",
      message: `Obsidian's ${what} output has an unexpected shape.`,
    });
  return r.data;
};

export function parseSearch(stdout: string): CliSearchResult[] {
  if (EMPTY.test(stdout.trim())) return [];
  // Obsidian lists a line once for every query word it contains.
  return parseJson(SearchResultSchema, stdout, "search").map((r) => ({
    file: r.file,
    matches: r.matches.filter((m, i, all) => all.findIndex((x) => x.line === m.line) === i),
  }));
}

/** A `format=json` table (backlinks, tags): one column's values. */
export function parseTable(stdout: string, column: string): string[] {
  if (EMPTY.test(stdout.trim()) || !stdout.trim()) return [];
  const rows = parseJson(z.array(z.record(z.string(), z.unknown())), stdout, column);
  return rows.map((r) => r[column]).filter((v): v is string => typeof v === "string" && !!v);
}

/** Plain list output (vaults): one value per line. */
export function parseLines(stdout: string): string[] {
  const text = stdout.trim();
  if (!text || EMPTY.test(text)) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `file` output: "key<TAB>value" lines; returns the note's path. */
export function parseFilePath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^path[\t ]+(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** `files total`: a count. */
export function parseCount(stdout: string): number | null {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A note's YAML frontmatter (null when absent or invalid) and the Markdown after it. */
export function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const m = FRONTMATTER.exec(text);
  if (!m) return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
  try {
    // `parse` with logLevel "silent" swallows errors too, so check the document.
    const doc = parseDocument(m[1] ?? "", { uniqueKeys: false });
    if (doc.errors.length > 0) return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
    const data: unknown = doc.toJS();
    const frontmatter =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    return { frontmatter, body: text.slice(m[0].length) };
  } catch {
    return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
  }
}

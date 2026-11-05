/**
 * Image links in the note's text (D70), pure. The note keeps an image as a
 * link like any other text: Obsidian's `![[name]]` (with `|width` or `#anchor`
 * parts, parsed off and ignored) or markdown's `![alt](target)` (the target in
 * `<...>` when it has spaces, or percent-encoded). Only local files with an
 * image extension count; a URL, a backslash or a drive is left alone
 * (nothing is fetched or asked for). Links in code spans and fenced code
 * count too: the scan is per line, not per markdown node. The
 * editor shows each one under its line; the reading sends the model a block
 * with each transcribed image in its link's place as quoted lines
 * (`blockForModel`, D71), and records the text as it is.
 */

/** One image link in a line: where it is in the line and the file it names. */
export type ImageLink = {
  /** The link's range in the line, `![` to the closing bracket. */
  from: number;
  to: number;
  /** The file it names, decoded: a bare name or a path with `/`. */
  target: string;
  /** The file name alone, for "Image not found: name". */
  name: string;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const WIKI = /!\[\[([^\]\n]+?)\]\]/g;
/** `![alt](<target>)` or `![alt](target)`, the bare target allowing balanced parentheses. */
const MARKDOWN = /!\[[^\]\n]*\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\)/g;
/**
 * What is never a file in the vault: a backslash (a UNC path or a Windows
 * separator), a colon (a URL scheme, a drive) or NUL. Such a link is not
 * shown, so it is never even asked for (Rust refuses it too).
 */
const UNSAFE = /[\\:\0]/;

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

function link(from: number, to: number, raw: string): ImageLink | null {
  const target = raw.trim();
  if (!target || UNSAFE.test(target) || !IMAGE_EXT.test(target)) return null;
  return { from, to, target, name: target.split("/").pop() ?? target };
}

/** The image links of a line, in order. */
export function imageLinks(line: string): ImageLink[] {
  const out: ImageLink[] = [];
  for (const m of line.matchAll(WIKI)) {
    // `name|width` and `name#heading`: the file is what comes before either;
    // in a table Obsidian escapes the pipe as `\|`.
    let target = (m[1] ?? "").split("|")[0]?.split("#")[0] ?? "";
    if (target.endsWith("\\") && (m[1] ?? "").includes("\\|")) target = target.slice(0, -1);
    const found = link(m.index, m.index + m[0].length, target);
    if (found) out.push(found);
  }
  for (const m of line.matchAll(MARKDOWN)) {
    // The `#anchor` comes off before decoding, so an encoded %23 stays in the name.
    const raw = (m[1] ?? m[2] ?? "").split("#")[0] ?? "";
    const target = m[1] !== undefined ? raw : decode(raw);
    const found = link(m.index, m.index + m[0].length, target);
    if (found) out.push(found);
  }
  return out.sort((a, b) => a.from - b.from);
}

/** What a transcribed image shows (D71), as the model will read it. */
export type ImageTranscript = { description: string; text: string };

/** The image links of a block's text in order, over all its lines. */
export function blockImageLinks(text: string): ImageLink[] {
  return text.split(/\r?\n/).flatMap((line) => imageLinks(line));
}

/**
 * A block's text as the model reads it (D71): each image link with a
 * transcript, keyed by the link's target, becomes quoted lines, `> [Image:
 * <name>: <description>]` and then the transcript's lines, each `> `. A link
 * alone on its line is replaced by the quote; a link among words is taken out
 * of the line and its quote follows the line, so the user's words stay the
 * instruction over the pasted input. Links without a transcript stay as they
 * are. The note itself is never changed: this is for the model only.
 */
export function blockForModel(
  text: string,
  reads: ReadonlyMap<string, ImageTranscript>,
  /** Most characters of each transcript; the rest becomes "[... clipped]" inside the quote. */
  opts: { quoteChars?: number } = {},
): string {
  if (!reads.size) return text;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const links = imageLinks(line).filter((l) => reads.has(l.target));
    if (!links.length) {
      out.push(line);
      continue;
    }
    let rest = "";
    let at = 0;
    for (const l of links) {
      rest += line.slice(at, l.from);
      at = l.to;
    }
    rest += line.slice(at);
    // What is left of the line once its links are out: words, or nothing (a
    // bare quote marker or list bullet is nothing).
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const words = indent + rest.trim().replace(/[ \t]{2,}/g, " ");
    if (words.replace(/^[\s>*+-]*(?:\[[ xX]\])?/, "").trim()) out.push(words);
    for (const l of links) out.push(...quoteImage(l.name, reads.get(l.target), opts.quoteChars));
  }
  return out.join("\n");
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

function quoteImage(
  name: string,
  read: ImageTranscript | undefined,
  max = Number.POSITIVE_INFINITY,
): string[] {
  if (!read) return [];
  const head = `> [Image: ${flat(name)}: ${flat(read.description)}]`;
  const full = read.text.trim();
  const text = full.length > max ? `${full.slice(0, max).trimEnd()}\n[... clipped]` : full;
  const body = text ? text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">")) : [];
  return [head, ...body];
}

/**
 * Inserts an image's link on its own line at the cursor: a newline before it
 * when the cursor's line has text before the cursor, and one after, so the
 * cursor lands at the start of the line after the link.
 */
export function insertImageLink(
  doc: string,
  cursor: number,
  link: string,
): { changes: { from: number; insert: string }; cursor: number } {
  const lineStart = doc.lastIndexOf("\n", cursor - 1) + 1;
  const before = cursor > lineStart ? "\n" : "";
  const insert = `${before}${link}\n`;
  return { changes: { from: cursor, insert }, cursor: cursor + insert.length };
}

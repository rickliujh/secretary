/**
 * Image links in the note's text (D70), pure. The note keeps an image as a
 * link like any other text: Obsidian's `![[name]]` (with `|width` or `#anchor`
 * parts, parsed off and ignored) or markdown's `![alt](target)` (the target in
 * `<...>` when it has spaces, or percent-encoded). Only local files with an
 * image extension count; a URL, a backslash or a drive is left alone
 * (nothing is fetched or asked for). Links in code spans and fenced code
 * count too: the scan is per line, not per markdown node. The
 * editor shows each one under its line; the reading never sees anything but
 * the text.
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

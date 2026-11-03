/**
 * The daily note split into blocks (D65), in code: paragraphs by blank line,
 * each list item its own block (with its indented continuation lines), a
 * fenced code block one block. Headings are no blocks; they name the section
 * of the blocks under them, and blocks under the private heading (and its
 * subheadings) are private. A leading YAML frontmatter is skipped. Each block
 * is normalised and hashed, so the same words are recognised at the next
 * read wherever they moved. Pure.
 */

export type NoteBlock = {
  /** The block as written, trimmed. */
  text: string;
  /** Whitespace collapsed per line, a ticked box written `[x]`. */
  norm: string;
  hash: string;
  /** The heading above it, or null. */
  section: string | null;
  /** Order in the note, from 0. */
  position: number;
  /** A `- [ ]` line: false; `- [x]`: true; no checkbox: null. */
  checked: boolean | null;
  /** The hash of the same block unticked; null when it has no checkbox. */
  uncheckedHash: string | null;
  /** Under the private heading: never sent to a model. */
  private: boolean;
  /**
   * Its first and last line in the body, 0-based (D67): a paragraph or list
   * item spans its lines, a fenced block its fences.
   */
  fromLine: number;
  toLine: number;
};

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CHECKBOX = /^([-*+]|\d{1,9}[.)])\s+\[([ xX])\](\s|$)/;

/** cyrb53: a fast 53-bit string hash, as 14 hex digits. */
export function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Each line trimmed with inner whitespace collapsed; blank lines dropped; `[X]` as `[x]`. */
export function normaliseBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .replace(CHECKBOX, (m) => m.replace("[X]", "[x]"));
}

/** The hash of a ticked block's text unticked; null when it is not a ticked box. */
export function uncheckedHashOf(text: string): string | null {
  const norm = normaliseBlock(text);
  const box = CHECKBOX.exec(norm);
  if (!box || box[2] === " ") return null;
  return hashText(norm.replace(CHECKBOX, (m) => m.replace("[x]", "[ ]")));
}

/** Whether a block says anything once list markers and an empty checkbox are gone. */
const hasWords = (norm: string) =>
  norm
    .replace(CHECKBOX, "")
    .replace(/^([-*+]|\d{1,9}[.)])(\s+|$)/, "")
    .trim() !== "";

/** Whether the heading names the private section (case and spacing ignored). */
export const isPrivateHeading = (heading: string, privateHeading: string) =>
  heading.trim().replace(/\s+/g, " ").toLowerCase() ===
  privateHeading.trim().replace(/\s+/g, " ").toLowerCase();

const YAML_KEY = /^[A-Za-z0-9_-]+\s*:/;
const YAML_LINE = /^(\s*[A-Za-z0-9_-]+\s*:|\s+\S|\s*-\s)/;

/**
 * How many leading lines are YAML frontmatter: a `---` line, `key:` lines
 * (with indented or list continuations), and a closing `---` or `...`. A
 * leading `---` over anything else is a horizontal rule, not frontmatter.
 */
function frontmatterLength(all: readonly string[]): number {
  if (all[0]?.trim() !== "---") return 0;
  const end = all.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  if (end === -1) return 0;
  const inner = all.slice(1, end).filter((l) => l.trim() !== "");
  const yaml = inner.every((l) => YAML_LINE.test(l)) && inner.some((l) => YAML_KEY.test(l));
  return yaml ? end + 1 : 0;
}

type LineKind =
  | "frontmatter"
  | "fence-open"
  | "fenced"
  | "fence-close"
  | "heading"
  | "blank"
  | "item"
  | "text";

export type ScannedLine = {
  line: string;
  kind: LineKind;
  /** The heading above the line (at a heading: its own title). */
  section: string | null;
  /** Under the private heading (its subheadings too), or the private heading itself. */
  private: boolean;
};

/**
 * Each line of the note with what it is, one pass shared by the splitter and
 * the chat's read. A fence that is never closed is no fence: its lines are
 * read as ordinary text, so a heading after it still counts.
 */
export function scanLines(body: string, privateHeading = "Private"): ScannedLine[] {
  const all = body.split(/\r?\n/);
  const out: ScannedLine[] = [];
  const front = frontmatterLength(all);
  for (let i = 0; i < front; i++)
    out.push({ line: all[i] ?? "", kind: "frontmatter", section: null, private: false });
  let section: string | null = null;
  let privateLevel: number | null = null;
  let fence: string | null = null;
  for (let i = front; i < all.length; i++) {
    const line = all[i] ?? "";
    const inPrivate = privateLevel !== null;
    if (fence !== null) {
      const closing = line.trim().startsWith(fence);
      out.push({ line, kind: closing ? "fence-close" : "fenced", section, private: inPrivate });
      if (closing) fence = null;
      continue;
    }
    const fenceOpen = FENCE.exec(line);
    if (fenceOpen) {
      const marker = fenceOpen[1] ?? "```";
      if (all.slice(i + 1).some((l) => l.trim().startsWith(marker))) {
        fence = marker;
        out.push({ line, kind: "fence-open", section, private: inPrivate });
        continue;
      }
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const title = heading[2] ?? "";
      if (privateLevel !== null && level <= privateLevel) privateLevel = null;
      if (privateLevel === null && isPrivateHeading(title, privateHeading)) privateLevel = level;
      section = title || null;
      out.push({ line, kind: "heading", section, private: privateLevel !== null });
      continue;
    }
    const kind: LineKind = line.trim() === "" ? "blank" : LIST_ITEM.test(line) ? "item" : "text";
    out.push({ line, kind, section, private: inPrivate });
  }
  return out;
}

/** The note without its private sections, for anything that may reach a model (the chat). */
export function withoutPrivate(body: string, privateHeading = "Private"): string {
  return scanLines(body, privateHeading)
    .filter((l) => !l.private)
    .map((l) => l.line)
    .join("\n");
}

type RawBlock = {
  lines: string[];
  section: string | null;
  private: boolean;
  fromLine: number;
  toLine: number;
};

export function splitBlocks(body: string, privateHeading = "Private"): NoteBlock[] {
  const raw: RawBlock[] = [];
  const at: { current: RawBlock | null } = { current: null };
  const close = () => {
    if (at.current) raw.push(at.current);
    at.current = null;
  };
  const open = (l: ScannedLine, i: number) => {
    at.current = {
      lines: [l.line],
      section: l.section,
      private: l.private,
      fromLine: i,
      toLine: i,
    };
  };
  const add = (l: ScannedLine, i: number) => {
    if (!at.current) return;
    at.current.lines.push(l.line);
    at.current.toLine = i;
  };

  for (const [i, l] of scanLines(body, privateHeading).entries()) {
    switch (l.kind) {
      case "frontmatter":
        break;
      case "fence-open":
        close();
        open(l, i);
        break;
      case "fenced":
        add(l, i);
        break;
      case "fence-close":
        add(l, i);
        close();
        break;
      case "heading":
      case "blank":
        close();
        break;
      case "item":
        close();
        open(l, i);
        break;
      default:
        if (at.current) add(l, i);
        else open(l, i);
    }
  }
  close();

  const out: NoteBlock[] = [];
  for (const b of raw) {
    const text = b.lines.join("\n").trim();
    const norm = normaliseBlock(text);
    if (!hasWords(norm)) continue;
    const box = CHECKBOX.exec(norm);
    const checked = box ? box[2] !== " " : null;
    out.push({
      text,
      norm,
      hash: hashText(norm),
      section: b.section,
      position: out.length,
      checked,
      uncheckedHash: box ? hashText(norm.replace(CHECKBOX, (m) => m.replace("[x]", "[ ]"))) : null,
      private: b.private,
      fromLine: b.fromLine,
      toLine: b.toLine,
    });
  }
  return out;
}

/** Word overlap of two blocks (Jaccard over lower-case words), 0 to 1. */
export function similarity(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

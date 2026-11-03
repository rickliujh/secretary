/**
 * The three-way merge of the daily note (D65): the text both sides last agreed
 * on (`base`), the page's text and the vault file's text, line by line with
 * `node-diff3`. Nothing either side wrote is lost: a hunk both sides changed
 * keeps both: the file's lines first, then a blank line and the page's lines the file does not
 * already hold after them. Pure.
 */
import { diff3Merge } from "node-diff3";

export type MergeResult = {
  text: string;
  /**
   * Both sides changed the same lines since the last sync, so both versions
   * were kept. Lines both sides only added at the same place are no conflict.
   */
  conflict: boolean;
};

const lines = (text: string) => {
  if (text === "") return [];
  const out = text.split(/\r?\n/);
  // A final line break is no line of its own.
  if (out.at(-1) === "") out.pop();
  return out;
};

const endsWithBreak = (text: string) => /\r?\n$/.test(text);

/** Merges the page's and the file's edits since `base`; the file's order wins a tie. */
export function mergeNote(base: string, page: string, file: string): MergeResult {
  if (page === file) return { text: file, conflict: false };
  if (base === page) return { text: file, conflict: false };
  if (base === file) return { text: page, conflict: false };
  const out: string[] = [];
  let conflict = false;
  /** The page's lines just went in: the next text gets a blank line before it. */
  let gap = false;
  const push = (more: readonly string[]) => {
    if (gap && more.length && more[0]?.trim() !== "" && out.length) out.push("");
    gap = false;
    out.push(...more);
  };
  for (const region of diff3Merge<string>(lines(file), lines(base), lines(page), {
    excludeFalseConflicts: true,
  })) {
    if (region.ok) push(region.ok);
    else if (region.conflict) {
      const { a, o, b } = region.conflict;
      // Only non-blank lines count as already held: blank lines keep the page's paragraphs apart.
      const fromFile = new Set(a.filter((l) => l.trim() !== ""));
      const mine = b.filter((l) => l.trim() === "" || !fromFile.has(l));
      while (mine[0]?.trim() === "") mine.shift();
      while (mine.at(-1)?.trim() === "") mine.pop();
      push(a);
      if (mine.length) {
        // A blank line between the file's lines and the page's, so neither runs into the other.
        if (out.length && out.at(-1)?.trim() !== "") out.push("");
        out.push(...mine);
        gap = true;
      }
      if (o.length > 0) conflict = true;
    }
  }
  // The file is the record: it keeps its final line break, or the page's when it has none.
  const trailing = file !== "" ? endsWithBreak(file) : endsWithBreak(page);
  const text = out.join("\n");
  return { text: trailing && text !== "" ? `${text}\n` : text, conflict };
}

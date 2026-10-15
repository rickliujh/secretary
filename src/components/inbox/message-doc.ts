/**
 * The message box document as message parts (D56). Pure functions over the
 * editor's ProseMirror JSON, so they are testable without a DOM.
 */
import type { JSONContent } from "@tiptap/core";
import { type MessagePart, mergeParts } from "@/services/intake/thread";

/** Name of the mark on pasted text. */
export const PASTED_MARK = "pasted";

/** How pasted text is highlighted, in the message box and in threads (theme tokens). */
export const PASTED_HIGHLIGHT = "rounded-sm bg-pasted text-pasted-foreground box-decoration-clone";

type Type = MessagePart["type"];

const typeOf = (node: JSONContent): Type =>
  node.marks?.some((m) => m.type === PASTED_MARK) ? "pasted" : "typed";

/**
 * The editor document as ordered parts: pasted text where the `pasted` mark is,
 * typed text elsewhere. Hard breaks and paragraph breaks become "\n"; a break
 * belongs to a paste when the paste runs across it. Adjacent parts of the same
 * type are merged.
 */
export function docToParts(doc: JSONContent): MessagePart[] {
  const parts: MessagePart[] = [];
  let previous: Type | null = null;
  (doc.content ?? []).forEach((block, i) => {
    const inline = block.content ?? [];
    if (i > 0) {
      const next = inline[0] ? typeOf(inline[0]) : null;
      parts.push({
        type: previous === "pasted" && next === "pasted" ? "pasted" : "typed",
        text: "\n",
      });
    }
    previous = null;
    for (const node of inline) {
      const type = typeOf(node);
      if (node.type === "text") parts.push({ type, text: node.text ?? "" });
      else if (node.type === "hardBreak") parts.push({ type, text: "\n" });
      previous = type;
    }
  });
  const merged = mergeParts(parts);
  // Blank typing around the message is dropped; a paste keeps its own spacing.
  const first = merged[0];
  if (first?.type === "typed") first.text = first.text.trimStart();
  const last = merged.at(-1);
  if (last?.type === "typed") last.text = last.text.trimEnd();
  return merged.filter((p) => p.text !== "");
}

/**
 * Lines of pasted text as editor content carrying the mark (or none when
 * `marked` is false). Empty lines become consecutive hard breaks.
 */
export function pastedContent(text: string, marked: boolean): JSONContent[] {
  const marks = marked ? [{ type: PASTED_MARK }] : undefined;
  const out: JSONContent[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push({ type: "hardBreak", ...(marks ? { marks } : {}) });
    if (line) out.push({ type: "text", text: line, ...(marks ? { marks } : {}) });
  });
  return out;
}

/**
 * Clipboard text ready to insert: Windows line endings made plain, and blank
 * lines at the start and end dropped (copying a line often brings its newline).
 * Empty when nothing but whitespace is left.
 */
export function cleanPaste(text: string): string {
  const t = text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
  return t.trim() ? t : "";
}

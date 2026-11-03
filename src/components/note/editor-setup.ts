/**
 * What keeps the note's text as typed in the editor (D67). CodeMirror's
 * standard keymap indents and trims on Enter and deletes an indent unit on
 * Backspace; here Enter inserts "\n" and Backspace deletes one character, as
 * the textarea did. Pasted "\r\n" becomes "\n" (the textarea did the same);
 * the loaded text keeps its line endings. A value that arrives from outside is
 * one change over the common prefix and suffix, kept out of the undo history,
 * so Ctrl+Z never takes back a sync or the chat's append.
 */
import { deleteCharBackwardStrict, insertNewline } from "@codemirror/commands";
import { Prec, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, type KeyBinding, keymap } from "@codemirror/view";
import { ExternalChange } from "@uiw/react-codemirror";
import { minimalChange } from "./doc-change";

export const NOTE_KEY_BINDINGS: readonly KeyBinding[] = [
  { key: "Enter", run: insertNewline, shift: insertNewline },
  { key: "Backspace", run: deleteCharBackwardStrict, shift: deleteCharBackwardStrict },
];

export const noteTyping = [
  Prec.highest(keymap.of(NOTE_KEY_BINDINGS)),
  EditorView.clipboardInputFilter.of((text) => text.replace(/\r\n/g, "\n")),
];

/** The transaction that brings the editor's text to `value`; null when it is already there. */
export function externalChange(doc: string, value: string): TransactionSpec | null {
  const changes = minimalChange(doc, value);
  if (!changes) return null;
  return {
    changes,
    annotations: [ExternalChange.of(true), Transaction.addToHistory.of(false)],
  };
}

/**
 * Terminal-style Ctrl+W (D38): deletes the word before the cursor, and the
 * spaces between it and the cursor, back to the previous whitespace.
 */

/** Where the word before `cursor` starts (unix-word-rubout). */
export function wordStartBefore(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text.charAt(i - 1))) i--;
  while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--;
  return i;
}

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "password", ""]);

const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type));

/**
 * Deletes the selection, or the word before the cursor, in the focused text field.
 * Goes through the editing commands so undo and React's onChange both work.
 */
export function deleteWordInFocused(): void {
  const el = document.activeElement;
  if (isTextField(el)) {
    if (el.readOnly || el.disabled) return;
    const end = el.selectionEnd ?? el.value.length;
    const start = el.selectionStart ?? end;
    const from = start !== end ? start : wordStartBefore(el.value, end);
    if (from === end) return;
    el.setSelectionRange(from, end);
    if (!document.execCommand("delete")) {
      el.setRangeText("", from, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    const sel = window.getSelection();
    if (sel?.isCollapsed) sel.modify("extend", "backward", "word");
    document.execCommand("delete");
  }
}

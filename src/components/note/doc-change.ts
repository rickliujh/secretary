/**
 * The one change that turns the editor's text into a value that arrived from
 * outside (a sync, the chat's append), over the common prefix and suffix
 * (D67), so the cursor and the scroll stay where they were. Pure.
 */
export type DocChange = { from: number; to: number; insert: string };

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Null when the texts are equal. Never splits a surrogate pair. */
export function minimalChange(from: string, to: string): DocChange | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  // Do not end the prefix between the halves of a pair.
  if (start > 0 && start < max && isHigh(from.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < max - start &&
    from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)
  )
    end++;
  // Nor start the suffix there.
  if (end > 0 && end < max - start && isLow(from.charCodeAt(from.length - end))) end--;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

/** Applies a change to a string, as the editor would. */
export const applyChange = (text: string, c: DocChange) =>
  text.slice(0, c.from) + c.insert + text.slice(c.to);

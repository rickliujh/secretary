/**
 * The message box's editor pieces (D56): the `pasted` mark, pastes as plain text
 * with that mark, and the composer's keys.
 */
import { Extension, Mark } from "@tiptap/core";
import { joinBackward } from "@tiptap/pm/commands";
import { keydownHandler } from "@tiptap/pm/keymap";
import { Fragment, Slice } from "@tiptap/pm/model";
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { registerWordDelete, wordStartBefore } from "@/lib/delete-word";
import type { MessagePart } from "@/services/intake/thread";
import {
  cleanPaste,
  docToParts,
  PASTED_HIGHLIGHT,
  PASTED_MARK,
  pastedContent,
} from "./message-doc";

/**
 * Removes the mark from the paste under the cursor ("Use as my own words").
 * Ctrl+Shift+U is IBus's Unicode entry on Linux, and Option or AltGr letters type
 * characters on some layouts, so it is Ctrl/Cmd+Shift+O ("own words").
 */
export const UNMARK_KEY = "Mod-Shift-o";

/**
 * Someone else's text. Not inclusive, so typing at either edge of a paste is the
 * user's own; typing inside it stays part of the paste.
 */
export const Pasted = Mark.create({
  name: PASTED_MARK,
  inclusive: false,
  parseHTML: () => [{ tag: "mark[data-pasted]" }],
  renderHTML: () => ["mark", { "data-pasted": "", class: PASTED_HIGHLIGHT }, 0],
});

type Range = { from: number; to: number };

/**
 * Pasted runs in the cursor's paragraph that touch `from`..`to` (their edges
 * included, so a paste just made counts while the cursor sits after it).
 */
export function pastedRunsAt(state: EditorState, from: number, to: number): Range[] {
  const type = state.schema.marks[PASTED_MARK];
  if (!type) return [];
  const runs: Range[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    let run: Range | null = null;
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (type.isInSet(child.marks)) {
        if (run && run.to === start) run.to = start + child.nodeSize;
        else {
          run = { from: start, to: start + child.nodeSize };
          runs.push(run);
        }
      }
    });
    return false;
  });
  return runs.filter((r) => r.from <= to && r.to >= from);
}

/** Makes the pasted runs under the cursor or selection the user's own words. */
export const unmarkPasted: Command = (state, dispatch) => {
  const type = state.schema.marks[PASTED_MARK];
  const runs = pastedRunsAt(state, state.selection.from, state.selection.to);
  if (!type || runs.length === 0) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const r of runs) tr.removeMark(r.from, r.to, type);
    dispatch(tr);
  }
  return true;
};

/** Ctrl+W (D38): the selection, or the word before the cursor, back to whitespace. */
export const deletePreviousWord: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty) {
    dispatch?.(state.tr.deleteSelection());
    return true;
  }
  const { $from } = selection;
  if ($from.parentOffset === 0) return joinBackward(state, dispatch);
  // Hard breaks count as one character, so offsets match document positions.
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\n");
  const start = $from.start() + wordStartBefore(before, before.length);
  if (start === $from.pos) return false;
  dispatch?.(state.tr.delete(start, $from.pos));
  return true;
};

/** Empties the box after a message is sent; undo brings it back. */
export const clearMessage: Command = (state, dispatch) => {
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return false;
  dispatch?.(state.tr.replaceWith(0, state.doc.content.size, paragraph.create()));
  return true;
};

/** Sends the box's message as parts and empties the box; false when it is blank. */
export function sendMessage(
  view: Pick<EditorView, "state" | "dispatch">,
  onSend: (parts: MessagePart[]) => void,
): boolean {
  const parts = docToParts(view.state.doc.toJSON());
  if (!parts.some((p) => p.text.trim() !== "")) return false;
  onSend(parts);
  clearMessage(view.state, view.dispatch);
  return true;
}

/** Adds clipboard text at `tr`'s selection as plain text with the `pasted` mark; null when blank. */
function insertPasted(tr: Transaction, raw: string): Transaction | null {
  const text = cleanPaste(raw);
  if (!text) return null;
  const nodes = pastedContent(text, true).map((n) => tr.doc.type.schema.nodeFromJSON(n));
  return tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0)).scrollIntoView();
}

/** Clipboard text inserted at the cursor as plain text with the `pasted` mark; null when blank. */
export const pasteTransaction = (state: EditorState, raw: string) => insertPasted(state.tr, raw);

/** The parts of an editor view the composer's handlers use, so tests can stand in for it. */
type ViewLike = Pick<EditorView, "state" | "dispatch" | "composing" | "editable"> &
  Partial<Pick<EditorView, "dragging" | "posAtCoords">>;

/**
 * The composer's keys and paste handling as ProseMirror plugins. Enter and
 * Ctrl/Cmd+Enter send (never while an IME is composing), UNMARK_KEY makes a paste
 * the user's own words, every paste and outside drop is plain text with the mark
 * (formatting and images are dropped), and the app-wide Ctrl+W (D38) is handed to
 * this view while it has focus.
 */
export function composerPlugins(opts: { send: () => void }): Plugin[] {
  const send: Command = () => {
    opts.send();
    return true;
  };
  const keys = keydownHandler({ Enter: send, "Mod-Enter": send, [UNMARK_KEY]: unmarkPasted });
  return [
    new Plugin({
      key: new PluginKey("composer"),
      view: (view) => ({
        destroy: registerWordDelete(view.dom, () => {
          if (view.editable) deletePreviousWord(view.state, view.dispatch);
        }),
      }),
      props: {
        handleKeyDown: (view: ViewLike, event: KeyboardEvent) =>
          !event.isComposing && !view.composing && keys(view as EditorView, event),
        handlePaste: (view: ViewLike, event: ClipboardEvent, slice: Slice) => {
          const text =
            event.clipboardData?.getData("text/plain") ||
            slice.content.textBetween(0, slice.content.size, "\n", "\n");
          const tr = pasteTransaction(view.state, text);
          if (tr) view.dispatch(tr);
          return true;
        },
        // Text dropped from elsewhere is someone else's too; a move inside the box
        // keeps its marks.
        handleDrop: (view: ViewLike, event: DragEvent) => {
          if (view.dragging) return false;
          const tr = view.state.tr;
          const at = view.posAtCoords?.({ left: event.clientX, top: event.clientY });
          if (at) tr.setSelection(TextSelection.near(tr.doc.resolve(at.pos)));
          const done = insertPasted(tr, event.dataTransfer?.getData("text/plain") ?? "");
          if (done) view.dispatch(done);
          return true;
        },
      },
    }),
  ];
}

export type ComposerOptions = { send: () => void };

/** The composer's plugins as a TipTap extension, ahead of HardBreak's and the core keymaps. */
export const ComposerKeymap = Extension.create<ComposerOptions>({
  name: "composerKeymap",
  priority: 1000,
  addOptions: () => ({ send: () => undefined }),
  addProseMirrorPlugins() {
    return composerPlugins({ send: () => this.options.send() });
  },
});

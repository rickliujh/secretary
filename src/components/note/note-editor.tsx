/**
 * The note's editor (D67): CodeMirror 6 over the note's text, byte for byte.
 * Lines split on "\n" only, so a loaded "\r\n" note keeps its "\r"s; Enter,
 * Backspace and paste do what the textarea did, and nothing is indented,
 * closed or continued as you type (`editor-setup.ts`). A value that arrives
 * from outside (a sync, the chat's append) is applied as one change over the
 * common prefix and suffix, outside the undo history, so the cursor and the
 * scroll stay. Line wrapping, proportional type (monospace inside fenced code
 * only, headings a little larger), the app's light or dark theme
 * (next-themes), read-only for earlier days. No box around the note: it is
 * text on the page, as the mockup shows it, with the marks hanging in the
 * left margin. The marks and the hover come from `cards-extension`; `overlay`
 * (the card and its anchor) is placed in the editor's element, where the
 * anchor's coordinates are measured. Images pasted or dropped are saved and
 * linked, and each linked image shows under its line (`images-extension`, D70).
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { NoteCardsData } from "./block-marks";
import type { NoteCardStore } from "./card-store";
import { noteCards, setNoteCards } from "./cards-extension";
import { externalChange, noteTyping } from "./editor-setup";
import { noteImages } from "./images-extension";
import { noteImagesIO } from "./images-io";

const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "600", fontSize: "1.25em" },
  { tag: tags.heading2, fontWeight: "600", fontSize: "1.15em" },
  { tag: tags.heading3, fontWeight: "600", fontSize: "1.07em" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  {
    tag: [tags.processingInstruction, tags.meta, tags.url, tags.quote, tags.contentSeparator],
    color: "var(--muted-foreground)",
  },
]);

const fenceLine = Decoration.line({ class: "cm-note-fence" });

/** The lines of fenced code blocks, for monospace there only. */
function fenceLines(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges)
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "FencedCode") return;
        const last = doc.lineAt(node.to).number;
        for (let n = doc.lineAt(node.from).number; n <= last; n++)
          out.push(fenceLine.range(doc.line(n).from));
        return false;
      },
    });
  return Decoration.set(out, true);
}

const fences = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = fenceLines(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState))
        this.decorations = fenceLines(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const MONO = "var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace)";

/** The app's colours through its CSS variables; `dark` sets CodeMirror's own defaults. */
const themeFor = (dark: boolean) =>
  EditorView.theme(
    {
      "&": {
        color: "var(--foreground)",
        backgroundColor: "transparent",
        fontSize: "15px",
        // The marks' colours, as the mockup has them: blue, amber, red, green, purple.
        "--note-mark-waiting": dark ? "#60a5fa" : "#2563eb",
        "--note-mark-question": dark ? "#f59e0b" : "#d97706",
        "--note-mark-failed": dark ? "#f87171" : "#dc2626",
        "--note-mark-done": dark ? "#4ade80" : "#16a34a",
        "--note-mark-noted": dark ? "#a78bfa" : "#7c3aed",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.6" },
      // As tall as the textarea was, and all of it clickable.
      ".cm-content": { padding: "8px 0", minHeight: "50vh", caretColor: "var(--foreground)" },
      ".cm-line": { padding: "0 10px 0 4px", borderRadius: "4px" },
      ".cm-note-fence": { fontFamily: MONO, fontSize: "13.5px" },
      ".cm-note-lit": { backgroundColor: "color-mix(in oklch, var(--muted) 70%, transparent)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)" },
      ".cm-placeholder": { color: "var(--muted-foreground)" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      // The marks hang in the page's left margin, as in the mockup: the text's
      // left edge is the heading's, and the mark sits a little before it.
      ".cm-note-marks .cm-gutterElement": {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        width: "20px",
        padding: "0",
      },
      // The mark: small, in the margin, quiet until its line is hovered (D67).
      ".cm-note-mark": {
        position: "relative",
        display: "inline-grid",
        placeItems: "center",
        width: "15px",
        height: "15px",
        // Centred on the 15 px / 1.6 line; em here would be the mark's own 10 px.
        marginTop: "calc((15px * 1.6 - 15px) / 2)",
        padding: "0",
        border: "none",
        borderRadius: "50%",
        background: "transparent",
        color: "var(--muted-foreground)",
        fontFamily: "var(--font-sans)",
        fontSize: "10px",
        fontWeight: "700",
        lineHeight: "1",
        cursor: "pointer",
        outline: "none",
      },
      "button.cm-note-mark:focus-visible": { boxShadow: "0 0 0 2px var(--ring)" },
      ".cm-note-mark-waiting": { backgroundColor: "var(--note-mark-waiting)", color: "#fff" },
      ".cm-note-mark-question": { backgroundColor: "var(--note-mark-question)", color: "#fff" },
      ".cm-note-mark-failed": { backgroundColor: "var(--note-mark-failed)", color: "#fff" },
      ".cm-note-mark-done": { color: "var(--note-mark-done)" },
      ".cm-note-mark-noted": { color: "var(--note-mark-noted)" },
      ".cm-note-mark-unread": {
        border: "1.5px solid var(--muted-foreground)",
        width: "11px",
        height: "11px",
        marginTop: "calc((15px * 1.6 - 11px) / 2)",
        animation: "cm-note-pulse 1.6s ease-in-out infinite",
      },
      "@keyframes cm-note-pulse": { "50%": { opacity: "0.35" } },
      ".cm-note-mark-ghost, .cm-note-mark-private": { opacity: "0" },
      ".cm-note-mark-ghost.cm-note-mark-lit, .cm-note-mark-private.cm-note-mark-lit, .cm-note-mark-ghost:focus-visible, .cm-note-mark-private:focus-visible":
        { opacity: "0.7" },
      // Images under their lines (D70): the column's width, at most 320 px tall.
      ".cm-note-image": { padding: "0 10px 0 4px" },
      ".cm-note-image img": {
        display: "block",
        maxWidth: "100%",
        maxHeight: "320px",
        margin: "6px 0",
        borderRadius: "6px",
      },
      ".cm-note-image-missing": {
        display: "block",
        margin: "6px 0",
        color: "var(--muted-foreground)",
        fontSize: "13px",
      },
      ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)" },
    },
    { dark },
  );
const lightTheme = [themeFor(false), syntaxHighlighting(highlight)];
const darkTheme = [themeFor(true), syntaxHighlighting(highlight)];

/** What CodeMirror's basic setup keeps: history, search, multiple cursors; no reformatting aids. */
const SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLineGutter: false,
  highlightActiveLine: false,
  highlightSpecialChars: false,
  highlightSelectionMatches: false,
  indentOnInput: false,
  bracketMatching: false,
  closeBrackets: false,
  closeBracketsKeymap: false,
  autocompletion: false,
  completionKeymap: false,
  foldKeymap: false,
  lintKeymap: false,
  syntaxHighlighting: false,
  rectangularSelection: false,
  crosshairCursor: false,
} satisfies BasicSetupOptions;

export function NoteEditor({
  value,
  onChange,
  readOnly,
  placeholder,
  label,
  cards,
  store,
  overlay,
  className,
}: {
  value: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  placeholder: string;
  /** The editor's accessible name. */
  label: string;
  cards: NoteCardsData;
  /** The hover cards' store: the block under the pointer, the open card, its anchor. */
  store: NoteCardStore;
  /** Placed in the editor's box: the card and its anchor. */
  overlay?: ReactNode;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const [view, setView] = useState<EditorView | null>(null);
  // CodeMirror keeps its own document; only the first value goes in as a prop,
  // later ones as minimal changes (below), so it never replaces the whole text.
  const [initial] = useState(value);
  const changed = useRef(onChange);
  changed.current = onChange;
  const handleChange = useCallback((text: string) => changed.current(text), []);
  // Stable: a new array would make the wrapper reconfigure the editor.
  const extensions = useMemo(
    () => [
      EditorState.lineSeparator.of("\n"),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label }),
      markdown({ base: markdownLanguage, addKeymap: false }),
      fences,
      noteTyping,
      noteCards(store),
      noteImages(noteImagesIO),
    ],
    [label, store],
  );

  useEffect(() => {
    if (!view) return;
    const spec = externalChange(view.state.doc.toString(), value);
    if (spec) view.dispatch(spec);
  }, [view, value]);

  useEffect(() => {
    view?.dispatch({ effects: setNoteCards.of(cards) });
  }, [view, cards]);

  return (
    <div
      className={cn(
        // No box around the note (the mockup): text on the page, the marks'
        // gutter hanging 24 px into the page's padding so the text aligns with
        // the heading above it.
        "relative -ml-6",
        className,
      )}
    >
      <CodeMirror
        value={initial}
        onChange={handleChange}
        onCreateEditor={setView}
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={SETUP}
        indentWithTab={false}
        theme={resolvedTheme === "dark" ? darkTheme : lightTheme}
        extensions={extensions}
      />
      {overlay}
    </div>
  );
}

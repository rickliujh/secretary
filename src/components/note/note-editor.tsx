/**
 * The note's editor (D67): CodeMirror 6 over the note's text, byte for byte.
 * Lines split on "\n" only, so a loaded "\r\n" note keeps its "\r"s; Enter,
 * Backspace and paste do what the textarea did, and nothing is indented,
 * closed or continued as you type (`editor-setup.ts`). A value that arrives
 * from outside (a sync, the chat's append) is applied as one change over the
 * common prefix and suffix, outside the undo history, so the cursor and the
 * scroll stay. Line wrapping, monospace, the app's light or dark theme (next-themes),
 * read-only for earlier days. Marks and strips come from `cards-extension`.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { NoteCardsData } from "./block-marks";
import { noteCards, type SlotStore, setNoteCards } from "./cards-extension";
import { externalChange, noteTyping } from "./editor-setup";

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  {
    tag: [tags.processingInstruction, tags.meta, tags.url, tags.quote, tags.contentSeparator],
    color: "var(--muted-foreground)",
  },
]);

/** The app's colours through its CSS variables; `dark` sets CodeMirror's own defaults. */
const themeFor = (dark: boolean) =>
  EditorView.theme(
    {
      "&": {
        color: "var(--foreground)",
        backgroundColor: "transparent",
        fontSize: "inherit",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5" },
      // As tall as the textarea was, and all of it clickable.
      ".cm-content": { padding: "8px 0", minHeight: "50vh", caretColor: "var(--foreground)" },
      ".cm-line": { padding: "0 10px 0 4px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)" },
      ".cm-placeholder": { color: "var(--muted-foreground)" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      ".cm-note-marks .cm-gutterElement": {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "0 2px 0 6px",
      },
      ".cm-note-mark": { display: "inline-flex", width: "16px", minHeight: "1.5em" },
      ".cm-note-strip": { padding: "0 10px 0 4px", overflow: "hidden" },
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
  slots,
  className,
}: {
  value: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  placeholder: string;
  /** The editor's accessible name. */
  label: string;
  cards: NoteCardsData;
  /** Where the marks' and strips' DOM nodes are registered for the page. */
  slots: SlotStore;
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
      noteTyping,
      noteCards(slots),
    ],
    [label, slots],
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
        "rounded-lg border border-input font-mono text-base transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 md:text-sm dark:bg-input/30",
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
    </div>
  );
}

import { describe, expect, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { externalChange, NOTE_KEY_BINDINGS } from "./editor-setup";

const at = (doc: string, cursor: number, extensions = [] as never[]) =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [EditorState.lineSeparator.of("\n"), ...extensions],
  });

/** Runs a binding as CodeMirror's keymap would, on a state alone. */
function press(state: EditorState, key: string): EditorState {
  const binding = NOTE_KEY_BINDINGS.find((b) => b.key === key);
  let next = state;
  const target = {
    state,
    dispatch: (tr: Transaction) => {
      next = tr.state;
    },
  } as unknown as EditorView;
  expect(binding?.run?.(target)).toBe(true);
  return next;
}

describe("typing in the note keeps the text as typed (D67)", () => {
  test("Enter inserts a newline: no indent copied, no whitespace removed", () => {
    expect(press(at("  - item", 8), "Enter").doc.toString()).toBe("  - item\n");
    expect(press(at("abc   def", 3), "Enter").doc.toString()).toBe("abc\n   def");
  });

  test("Backspace deletes one character, not an indent unit", () => {
    expect(press(at("    x", 4), "Backspace").doc.toString()).toBe("   x");
  });

  test("a loaded CRLF note is kept byte for byte", () => {
    const s = press(at("one\r\ntwo\r\n", 10), "Enter");
    expect(s.doc.toString()).toBe("one\r\ntwo\r\n\n");
  });
});

describe("a value from outside (D67)", () => {
  test("is one minimal change, and undo takes back only the typing", () => {
    let state = at("line one\n", 9, [history()] as never[]);
    state = state.update({
      changes: { from: 9, insert: "typed" },
      selection: EditorSelection.cursor(14),
      userEvent: "input.type",
    }).state;
    const spec = externalChange(state.doc.toString(), "from obsidian\nline one\ntyped");
    expect(spec?.changes).toEqual({ from: 0, to: 0, insert: "from obsidian\n" });
    state = state.update(spec ?? {}).state;
    // The cursor stays after what was typed.
    expect(state.selection.main.head).toBe(28);
    let undone = state;
    undo({
      state,
      dispatch: (tr) => {
        undone = tr.state;
      },
    });
    expect(undone.doc.toString()).toBe("from obsidian\nline one\n");
    expect(externalChange("same", "same")).toBeNull();
  });
});

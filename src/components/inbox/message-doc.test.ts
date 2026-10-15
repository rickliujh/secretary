import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { splitMessage } from "@/services/intake/thread";
import { cleanPaste, docToParts, pastedContent } from "./message-doc";
import {
  composerPlugins,
  deletePreviousWord,
  Pasted,
  pastedRunsAt,
  pasteTransaction,
  sendMessage,
  unmarkPasted,
} from "./pasted-mark";

const mark = [{ type: "pasted" }];
const text = (t: string, pasted = false) => ({
  type: "text",
  text: t,
  ...(pasted ? { marks: mark } : {}),
});
const br = (pasted = false) => ({ type: "hardBreak", ...(pasted ? { marks: mark } : {}) });
const doc = (...paragraphs: object[][]) => ({
  type: "doc",
  content: paragraphs.map((content) => ({ type: "paragraph", content })),
});

describe("docToParts", () => {
  test("pasted text inside a typed line keeps its place", () => {
    const parts = docToParts(
      doc([text("change the summary to "), text("Fix login", true), text(" please")]),
    );
    expect(parts).toEqual([
      { type: "typed", text: "change the summary to " },
      { type: "pasted", text: "Fix login" },
      { type: "typed", text: " please" },
    ]);
    expect(splitMessage(parts, false, true).instruction).toBe(
      "change the summary to «Fix login» please",
    );
  });

  test("hard breaks are new lines; a marked one belongs to the paste", () => {
    expect(
      docToParts(
        doc([
          text("Bob: line one", true),
          br(true),
          text("line two", true),
          br(),
          text("bump PAY-4"),
        ]),
      ),
    ).toEqual([
      { type: "pasted", text: "Bob: line one\nline two" },
      { type: "typed", text: "\nbump PAY-4" },
    ]);
  });

  test("paragraph breaks are new lines, pasted only inside one paste", () => {
    expect(docToParts(doc([text("one", true)], [text("two", true)], [text("do it")], []))).toEqual([
      { type: "pasted", text: "one\ntwo" },
      { type: "typed", text: "\ndo it" },
    ]);
  });

  test("blank typing around the message is dropped", () => {
    expect(docToParts(doc([text("  "), text(" a paste ", true), br(), br()]))).toEqual([
      { type: "pasted", text: " a paste " },
    ]);
    expect(docToParts(doc([]))).toEqual([]);
    expect(docToParts({ type: "doc" })).toEqual([]);
  });
});

describe("pasted content", () => {
  test("lines become text and hard breaks, all marked", () => {
    expect(pastedContent("a\n\nb", true)).toEqual([
      text("a", true),
      br(true),
      br(true),
      text("b", true),
    ]);
    expect(pastedContent("a\nb", false)).toEqual([text("a"), br(), text("b")]);
  });

  test("clipboard text loses Windows line endings and blank edges", () => {
    expect(cleanPaste("\r\n  \nline one\r\n  line two\r\n\r\n")).toBe("line one\n  line two");
    expect(cleanPaste(" \n\t\n")).toBe("");
  });
});

describe("editor commands", () => {
  const schema = getSchema([Document, Paragraph, Text, HardBreak, Pasted]);
  const stateAt = (json: object, from: number, to = from) => {
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(json) });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  };
  const run = (
    command: typeof unmarkPasted,
    state: EditorState,
  ): { ok: boolean; state: EditorState } => {
    let next = state;
    const ok = command(state, (tr: Transaction) => {
      next = state.apply(tr);
    });
    return { ok, state: next };
  };
  // "set " is positions 1-5, the paste 5-14, " now" 14-18.
  const sentence = doc([text("set "), text("Fix login", true), text(" now")]);

  test("the paste under the cursor is found, edges included", () => {
    expect(pastedRunsAt(stateAt(sentence, 8), 8, 8)).toEqual([{ from: 5, to: 14 }]);
    expect(pastedRunsAt(stateAt(sentence, 14), 14, 14)).toEqual([{ from: 5, to: 14 }]);
    expect(pastedRunsAt(stateAt(sentence, 2), 2, 2)).toEqual([]);
  });

  test("a paste across hard breaks is one run", () => {
    const state = stateAt(doc([text("a", true), br(true), text("b", true), text(" c")]), 2);
    expect(pastedRunsAt(state, 2, 2)).toEqual([{ from: 1, to: 4 }]);
  });

  test("Use as my own words removes the mark from the whole paste", () => {
    const { ok, state } = run(unmarkPasted, stateAt(sentence, 8));
    expect(ok).toBe(true);
    expect(docToParts(state.doc.toJSON())).toEqual([{ type: "typed", text: "set Fix login now" }]);
    expect(run(unmarkPasted, stateAt(sentence, 2)).ok).toBe(false);
  });

  test("Ctrl+W deletes back to the previous whitespace", () => {
    const { state } = run(deletePreviousWord, stateAt(sentence, 18));
    expect(state.doc.textContent).toBe("set Fix login ");
    const again = run(deletePreviousWord, state).state;
    expect(again.doc.textContent).toBe("set Fix ");
    const selected = run(deletePreviousWord, stateAt(sentence, 1, 5)).state;
    expect(selected.doc.textContent).toBe("Fix login now");
  });
});

describe("composer plugins", () => {
  const schema = getSchema([Document, Paragraph, Text, HardBreak, Pasted]);
  const stateAt = (json: object, pos: number) => {
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(json) });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  };
  /** Stands in for an EditorView: the handlers read state and call dispatch. */
  const viewOf = (state: EditorState, extra: Record<string, unknown> = {}) => {
    const view = {
      state,
      composing: false,
      editable: true,
      dragging: null as unknown,
      dispatch(tr: Transaction) {
        view.state = view.state.apply(tr);
      },
      ...extra,
    };
    return view;
  };
  const setup = () => {
    let sent = 0;
    const [plugin] = composerPlugins({ send: () => sent++ });
    if (!plugin) throw new Error("no plugin");
    return { props: plugin.props, sent: () => sent, plugin };
  };
  // Same test as prosemirror-keymap, so "Mod" means the same key here.
  const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key: k,
      keyCode: k === "Enter" ? 13 : k.toUpperCase().charCodeAt(0),
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      ...mods,
    }) as unknown as KeyboardEvent;
  const sentence = doc([text("set "), text("Fix login", true), text(" now")]);
  const typing = doc([text("change to ")]);

  test("Enter and Ctrl/Cmd+Enter send; not while an IME is composing; Shift+Enter is left alone", () => {
    const { plugin, props, sent } = setup();
    const down = (view: ReturnType<typeof viewOf>, e: KeyboardEvent) =>
      props.handleKeyDown?.call(plugin, view as never, e);
    const view = viewOf(stateAt(typing, 11));
    expect(down(view, key("Enter"))).toBe(true);
    expect(down(view, key("Enter", mac ? { metaKey: true } : { ctrlKey: true }))).toBe(true);
    expect(sent()).toBe(2);
    expect(down(view, key("Enter", { isComposing: true }))).toBe(false);
    expect(down(viewOf(stateAt(typing, 11), { composing: true }), key("Enter"))).toBe(false);
    expect(down(view, key("Enter", { shiftKey: true }))).toBe(false);
    expect(sent()).toBe(2);
  });

  test("Ctrl/Cmd+Shift+O makes the paste under the cursor the user's own words", () => {
    const { plugin, props } = setup();
    const view = viewOf(stateAt(sentence, 8));
    const unmark = key("O", { shiftKey: true, ...(mac ? { metaKey: true } : { ctrlKey: true }) });
    expect(props.handleKeyDown?.call(plugin, view as never, unmark)).toBe(true);
    expect(docToParts(view.state.doc.toJSON())).toEqual([
      { type: "typed", text: "set Fix login now" },
    ]);
  });

  test("a paste goes in at the cursor as plain text with the mark", () => {
    const { plugin, props } = setup();
    const view = viewOf(stateAt(typing, 11));
    const clipboard = (plain: string) =>
      ({ clipboardData: { getData: (t: string) => (t === "text/plain" ? plain : "") } }) as never;
    expect(
      props.handlePaste?.call(
        plugin,
        view as never,
        clipboard("\nAna: hi\r\nsecond\n"),
        Slice.empty,
      ),
    ).toBe(true);
    expect(docToParts(view.state.doc.toJSON())).toEqual([
      { type: "typed", text: "change to " },
      { type: "pasted", text: "Ana: hi\nsecond" },
    ]);
    // Typing after it is the user's own (the mark is not inclusive).
    view.dispatch(view.state.tr.insertText(" ok"));
    expect(docToParts(view.state.doc.toJSON()).at(-1)).toEqual({ type: "typed", text: " ok" });
    // Rich content without plain text keeps only its text.
    const html = new Slice(Fragment.from(schema.text("from html")), 0, 0);
    const other = viewOf(stateAt(typing, 11));
    props.handlePaste?.call(plugin, other as never, clipboard(""), html);
    expect(docToParts(other.state.doc.toJSON()).at(-1)).toEqual({
      type: "pasted",
      text: "from html",
    });
    // A blank paste changes nothing but is still handled.
    const blank = viewOf(stateAt(typing, 11));
    expect(props.handlePaste?.call(plugin, blank as never, clipboard(" \n "), Slice.empty)).toBe(
      true,
    );
    expect(blank.state.doc.eq(stateAt(typing, 11).doc)).toBe(true);
  });

  test("text dropped from elsewhere is marked where it lands; a move inside the box is not", () => {
    const { plugin, props } = setup();
    const drop = {
      clientX: 0,
      clientY: 0,
      dataTransfer: { getData: () => "dropped" },
    } as unknown as DragEvent;
    const view = viewOf(stateAt(typing, 11), { posAtCoords: () => ({ pos: 1, inside: -1 }) });
    expect(props.handleDrop?.call(plugin, view as never, drop, Slice.empty, false)).toBe(true);
    expect(docToParts(view.state.doc.toJSON())).toEqual([
      { type: "pasted", text: "dropped" },
      { type: "typed", text: "change to" },
    ]);
    const moving = viewOf(stateAt(typing, 11), { dragging: { slice: Slice.empty, move: true } });
    expect(props.handleDrop?.call(plugin, moving as never, drop, Slice.empty, true)).toBe(false);
  });

  test("pasteTransaction inserts marked lines; blank text gives none", () => {
    const tr = pasteTransaction(stateAt(typing, 11), "a\n\nb");
    expect(tr && docToParts(tr.doc.toJSON())).toEqual([
      { type: "typed", text: "change to " },
      { type: "pasted", text: "a\n\nb" },
    ]);
    expect(pasteTransaction(stateAt(typing, 11), "\n\t")).toBeNull();
  });

  test("sending hands over the parts and empties the box", () => {
    const view = viewOf(stateAt(sentence, 18));
    const got: unknown[] = [];
    expect(sendMessage(view, (parts) => got.push(parts))).toBe(true);
    expect(got).toEqual([
      [
        { type: "typed", text: "set " },
        { type: "pasted", text: "Fix login" },
        { type: "typed", text: " now" },
      ],
    ]);
    expect(view.state.doc.toJSON()).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    // Nothing to send: nothing happens.
    expect(sendMessage(view, (parts) => got.push(parts))).toBe(false);
    expect(got).toHaveLength(1);
  });
});

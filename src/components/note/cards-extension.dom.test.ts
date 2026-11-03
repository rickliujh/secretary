/**
 * The note's marks and hover plugin in a real EditorView (jsdom): a store
 * listener that pins a card when a mark first appears (as `/note?thread=`
 * does) runs inside the editor's update, and must not break the plugin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { hashText, normaliseBlock } from "@/services/note/blocks";
import type { NoteCardsData } from "./block-marks";
import { NoteCardStore } from "./card-store";
import { noteCards, setNoteCards } from "./cards-extension";

const GLOBALS = [
  "window",
  "Window",
  "document",
  "navigator",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "HTMLElement",
  "Node",
  "Element",
  "Text",
  "DocumentFragment",
  "Range",
] as const;
const saved = new Map<string, unknown>();

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  // jsdom has no layout: ranges measure as empty.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  Object.assign(dom.window.Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => rect,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) {
    saved.set(name, g[name]);
    const value = win[name];
    g[name] = typeof value === "function" && /^[a-z]/.test(name) ? value.bind(win) : value;
  }
  g.window = win;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [name, value] of saved) g[name] = value;
});

const h = (text: string) => hashText(normaliseBlock(text));
const NOTE = "send Dana the Q3 numbers\n\nlunch with Mia\n";
const data: NoteCardsData = {
  privateHeading: "Private",
  rows: new Map([
    [
      h("send Dana the Q3 numbers"),
      {
        hash: h("send Dana the Q3 numbers"),
        status: "acted",
        inboxItemId: "t1",
        workItemId: null,
        workItemName: null,
      },
    ],
  ]),
  threads: new Map(),
  reads: true,
};

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("the hover plugin in an EditorView (D67)", () => {
  test("a listener pinning the thread's card as its mark appears keeps the plugin alive", async () => {
    const store = new NoteCardStore();
    const errors: unknown[] = [];
    const logged = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    // Pins the thread's card synchronously, from inside the editor's update.
    let pinned = false;
    let pinning = false;
    store.subscribe(() => {
      if (pinned || pinning) return;
      pinning = true;
      pinned = store.pinThread("t1");
      pinning = false;
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: NOTE,
        extensions: [EditorState.lineSeparator.of("\n"), noteCards(store)],
      }),
      parent: document.body,
    });
    try {
      view.dispatch({ effects: setNoteCards.of(data) });
      await settle();
      expect(pinned).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ pinned: true });
      expect(errors).toEqual([]);
      // Still alive: a typed line is a new block whose mark the store hears of.
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nnew line\n" } });
      await settle();
      expect(store.getSnapshot().marks.size).toBe(3);
      // The pinned card's lines are lit, and its mark is in the gutter.
      expect(view.dom.querySelectorAll(".cm-note-lit").length).toBe(1);
      expect(view.dom.querySelector(".cm-note-mark-unread")).not.toBeNull();
      expect(errors).toEqual([]);
    } finally {
      view.destroy();
      console.error = logged;
    }
  });
});

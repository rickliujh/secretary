/**
 * The note's images in a real EditorView (jsdom, D70): a widget under each
 * linked image, kept while the line's words change and gone with its link,
 * and a pasted image saved and linked on its own line.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import {
  CACHED_IMAGES,
  invalidateNoteImages,
  loadNoteImage,
  MAX_IMAGE_BYTES,
  type NoteImagesIO,
  noteImages,
  pasteIsText,
} from "./images-extension";

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
  "Event",
  "DOMParser",
] as const;
const saved = new Map<string, unknown>();

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
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

beforeEach(() => invalidateNoteImages());

const settle = () => new Promise((r) => setTimeout(r, 20));

function fakeIO(found: Record<string, string>) {
  const loads: string[] = [];
  const saves: { data: Uint8Array; ext: string }[] = [];
  const failures: unknown[] = [];
  const unlinked: string[] = [];
  const io: NoteImagesIO = {
    save: async (data, ext) => {
      saves.push({ data, ext });
      return `![[Pasted image ${saves.length}.${ext}]]`;
    },
    load: async (target) => {
      loads.push(target);
      return found[target] ?? null;
    },
    failed: (e) => void failures.push(e),
    notLinked: (link) => void unlinked.push(link),
  };
  return { io, loads, saves, failures, unlinked };
}

const png = (size = 4) => ({
  type: "image/png",
  size,
  arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
});

/** A paste or drop event carrying files and, optionally, text and HTML. */
function transfer(
  type: "paste" | "drop",
  files: unknown[],
  text: Record<string, string> = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const data = {
    files,
    types: Object.keys(text),
    getData: (t: string) => text[t] ?? "",
  };
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: data,
  });
  return event;
}

function editor(doc: string, io: NoteImagesIO, readOnly = false) {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.lineSeparator.of("\n"),
        EditorState.readOnly.of(readOnly),
        noteImages(io),
      ],
    }),
    parent: document.body,
  });
}

const widgets = (view: EditorView) => [...view.dom.querySelectorAll<HTMLElement>(".cm-note-image")];

describe("images in the note's editor (D70)", () => {
  test("two links give two widgets; typing keeps them; removing a link removes its widget", async () => {
    const { io, loads } = fakeIO({ "a.png": "data:image/png;base64,AAAA" });
    const view = editor("see ![[a.png]] here\n\n![](b%20c.png)\n", io);
    try {
      await settle();
      const first = widgets(view);
      expect(first.map((w) => w.dataset.target)).toEqual(["a.png", "b c.png"]);
      expect(first[0]?.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      );
      expect(first[1]?.textContent).toBe("Image not found: b c.png");

      // The words on the line change; the widgets (and their loads) stay.
      view.dispatch({ changes: { from: 0, to: 3, insert: "look at" } });
      await settle();
      const after = widgets(view);
      expect(after).toHaveLength(2);
      expect(after[0]).toBe(first[0] as HTMLElement);
      expect(after[1]).toBe(first[1] as HTMLElement);
      expect(loads).toEqual(["a.png", "b c.png"]);

      // The link goes; its widget goes.
      const text = view.state.doc.toString();
      const at = text.indexOf("![[a.png]]");
      view.dispatch({ changes: { from: at, to: at + "![[a.png]]".length } });
      await settle();
      expect(widgets(view).map((w) => w.dataset.target)).toEqual(["b c.png"]);
    } finally {
      view.destroy();
    }
  });

  test("a pasted image is saved and its link inserted on its own line", async () => {
    const { io, saves } = fakeIO({});
    const view = editor("note: ", io);
    try {
      view.dispatch({ selection: { anchor: 6 } });
      const event = transfer("paste", [png()]);
      view.contentDOM.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await settle();
      expect(saves).toHaveLength(1);
      expect(saves[0]?.ext).toBe("png");
      expect([...(saves[0]?.data ?? [])]).toEqual([137, 80, 78, 71]);
      expect(view.state.doc.toString()).toBe("note: \n![[Pasted image 1.png]]\n");
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
      expect(widgets(view).map((w) => w.dataset.target)).toEqual(["Pasted image 1.png"]);
    } finally {
      view.destroy();
    }
  });

  test("a text paste is the editor's; a read-only day takes no paste; a failed save inserts nothing", async () => {
    const { io, saves, failures } = fakeIO({});
    const view = editor("x", io);
    const readOnly = editor("![[a.png]]", io, true);
    try {
      // Our handler lets a text paste through: the editor pastes the text as
      // a bare editor without the images extension does.
      const text = transfer("paste", [], { "text/plain": " hello" });
      const bare = new EditorView({
        state: EditorState.create({ doc: "x" }),
        parent: document.body,
      });
      const control = transfer("paste", [], { "text/plain": " hello" });
      bare.dispatch({ selection: { anchor: 1 } });
      bare.contentDOM.dispatchEvent(control);
      view.dispatch({ selection: { anchor: 1 } });
      view.contentDOM.dispatchEvent(text);
      expect(saves).toHaveLength(0);
      expect(view.state.doc.toString()).toBe(bare.state.doc.toString());
      expect(text.defaultPrevented).toBe(control.defaultPrevented);
      // CodeMirror itself prevents the default of the text paste it handles.
      expect(view.state.doc.toString()).toBe("x hello");
      bare.destroy();

      readOnly.contentDOM.dispatchEvent(transfer("paste", [png()]));
      await settle();
      expect(saves).toHaveLength(0);
      expect(readOnly.state.doc.toString()).toBe("![[a.png]]");
      // Read-only days still show their images.
      expect(widgets(readOnly)).toHaveLength(1);

      io.save = async () => {
        throw new Error("Obsidian did not answer");
      };
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "x" } });
      view.contentDOM.dispatchEvent(transfer("paste", [png()]));
      await settle();
      expect(failures).toHaveLength(1);
      expect(view.state.doc.toString()).toBe("x");
    } finally {
      view.destroy();
      readOnly.destroy();
    }
  });

  test("a copy from Excel or Word (text with a picture of it) pastes the text", async () => {
    expect(pasteIsText("", "")).toBe(false);
    expect(pasteIsText("a\tb", "")).toBe(true);
    expect(pasteIsText("a\tb", "<table><tr><td>a</td><td>b</td></tr></table>")).toBe(true);
    expect(pasteIsText("", "<p>Quarterly numbers</p>")).toBe(true);
    // A browser's "Copy image": one <img>, maybe wrapped, maybe with its URL as text.
    expect(pasteIsText("", '<meta charset="utf-8"><img src="https://x/a.png">')).toBe(false);
    expect(pasteIsText("https://x/a.png", '<html><body><img src="a.png"></body></html>')).toBe(
      false,
    );
    expect(pasteIsText("", '<img src="a.png"><img src="b.png">')).toBe(true);

    const { io, saves } = fakeIO({});
    const view = editor("", io);
    try {
      const excel = transfer("paste", [png()], {
        "text/plain": "Q3\t42",
        "text/html": "<table><tr><td>Q3</td><td>42</td></tr></table>",
      });
      view.contentDOM.dispatchEvent(excel);
      await settle();
      expect(saves).toHaveLength(0);
      const browser = transfer("paste", [png()], { "text/html": '<img src="https://x/a.png">' });
      view.contentDOM.dispatchEvent(browser);
      await settle();
      expect(saves).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  test("a dropped image is saved and linked at the drop point; a text drop falls through", async () => {
    const { io, saves } = fakeIO({});
    const view = editor("first\nsecond", io);
    try {
      // jsdom has no layout: the drop point is where posAtCoords says.
      view.posAtCoords = (() => 5) as typeof view.posAtCoords;
      const drop = transfer("drop", [png()]);
      view.contentDOM.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(true);
      await settle();
      expect(saves).toHaveLength(1);
      expect(view.state.doc.toString()).toBe("first\n![[Pasted image 1.png]]\n\nsecond");

      const text = transfer("drop", [], { "text/plain": "words" });
      view.contentDOM.dispatchEvent(text);
      await settle();
      expect(saves).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  test("an image over 20 MB is refused before it is read", async () => {
    const { io, saves, failures } = fakeIO({});
    const view = editor("", io);
    let read = false;
    const big = {
      type: "image/png",
      size: MAX_IMAGE_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    };
    try {
      view.contentDOM.dispatchEvent(transfer("paste", [big]));
      await settle();
      expect(read).toBe(false);
      expect(saves).toHaveLength(0);
      expect(String(failures[0])).toContain("the image is larger than 20 MB");
      expect(view.state.doc.toString()).toBe("");
    } finally {
      view.destroy();
    }
  });

  test("a save that ends after the editor closed is reported, not dispatched", async () => {
    const { io, unlinked } = fakeIO({});
    let finish: (link: string) => void = () => undefined;
    io.save = () => new Promise((r) => (finish = r));
    const view = editor("", io);
    view.contentDOM.dispatchEvent(transfer("paste", [png()]));
    await settle();
    view.destroy();
    finish("![[Pasted image 9.png]]");
    await settle();
    expect(unlinked).toEqual(["![[Pasted image 9.png]]"]);
  });

  test("Read now's invalidation loads the images again", async () => {
    const { io, loads } = fakeIO({ "a.png": "data:image/png;base64,AAAA" });
    const view = editor("![[a.png]]", io);
    try {
      await settle();
      expect(loads).toEqual(["a.png"]);
      invalidateNoteImages();
      await settle();
      expect(loads).toEqual(["a.png", "a.png"]);
      expect(widgets(view)).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  test("the cache keeps the most recently used images", async () => {
    const { io, loads } = fakeIO({});
    io.load = async (target) => {
      loads.push(target);
      return `data:image/png;base64,${target}`;
    };
    for (let i = 0; i <= CACHED_IMAGES; i++) await loadNoteImage(io, `${i}.png`);
    expect(loads).toHaveLength(CACHED_IMAGES + 1);
    // The first was the least recently used: it went; the last stayed.
    await loadNoteImage(io, `${CACHED_IMAGES}.png`);
    expect(loads).toHaveLength(CACHED_IMAGES + 1);
    await loadNoteImage(io, "0.png");
    expect(loads).toHaveLength(CACHED_IMAGES + 2);

    // By size: two images over 64 MB of data URLs keep only the later one.
    invalidateNoteImages();
    const huge = "A".repeat(40 * 1024 * 1024);
    io.load = async (target) => {
      loads.push(target);
      return `data:image/png;base64,${huge}`;
    };
    const before = loads.length;
    await loadNoteImage(io, "big1.png");
    await loadNoteImage(io, "big2.png");
    await loadNoteImage(io, "big2.png");
    expect(loads.length - before).toBe(2);
    await loadNoteImage(io, "big1.png");
    expect(loads.length - before).toBe(3);
  });
});

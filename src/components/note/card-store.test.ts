import { describe, expect, test } from "bun:test";
import type { BlockMark } from "./block-marks";
import { type Anchor, CLOSE_AFTER_MS, NoteCardStore, OPEN_AFTER_MS } from "./card-store";

/** Timers the test advances by hand. */
function clock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; f: () => void }>();
  return {
    timers: {
      set: (f: () => void, ms: number) => {
        const id = next++;
        due.set(id, { at: now + ms, f });
        return id;
      },
      clear: (id: unknown) => void due.delete(id as number),
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const first = [...due.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].f();
      }
      now = until;
    },
  };
}

const mark = (key: string, thread: string | null = null): BlockMark => ({
  key,
  hash: key,
  line: 0,
  toLine: 0,
  row: null,
  changed: false,
  private: false,
  thread,
  state: { kind: "alone" },
});

const anchor = (key: string): Anchor => ({
  key,
  top: 10,
  left: 0,
  width: 600,
  height: 24,
  side: "right",
});

function setup() {
  const c = clock();
  const store = new NoteCardStore(c.timers);
  store.setMarks(new Map([mark("a", "t1"), mark("b")].map((m) => [m.key, m])));
  const lit: string[][] = [];
  store.onLit = (keys) => void lit.push([...keys]);
  return { store, c, lit };
}

describe("the hover card's intent (D67)", () => {
  test("opens after the pointer rests on a block, not before", () => {
    const { store, c, lit } = setup();
    store.pointerAt("a");
    // The line lights at once; the card waits.
    expect(lit.at(-1)).toEqual(["a"]);
    expect(store.getSnapshot()).toMatchObject({ hovered: "a", shown: null });
    c.advance(OPEN_AFTER_MS - 1);
    expect(store.shown).toBeNull();
    c.advance(1);
    expect(store.getSnapshot()).toMatchObject({ shown: "a", pinned: false });
  });

  test("passing over a block opens nothing", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(100);
    store.pointerAt("b");
    c.advance(100);
    store.pointerAt(null);
    c.advance(1000);
    expect(store.shown).toBeNull();
  });

  test("stays while the pointer is on the block or the card; closes after leaving both", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(OPEN_AFTER_MS);
    // Off the line toward the card, and into it in time.
    store.pointerAt(null);
    c.advance(CLOSE_AFTER_MS - 10);
    store.pointerInCard(true);
    c.advance(1000);
    expect(store.shown).toBe("a");
    // Back on the line from the card.
    store.pointerInCard(false);
    store.pointerAt("a");
    c.advance(1000);
    expect(store.shown).toBe("a");
    // Left both.
    store.pointerAt(null);
    c.advance(CLOSE_AFTER_MS - 1);
    expect(store.shown).toBe("a");
    c.advance(1);
    expect(store.shown).toBeNull();
  });

  test("moving to another block: the card follows after the pause", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(OPEN_AFTER_MS);
    store.pointerAt("b");
    c.advance(CLOSE_AFTER_MS);
    expect(store.shown).toBeNull();
    c.advance(OPEN_AFTER_MS - CLOSE_AFTER_MS);
    expect(store.shown).toBe("b");
  });

  test("typing opens nothing and closes a hover card; a pinned one stays", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(100);
    store.typed();
    c.advance(1000);
    expect(store.shown).toBeNull();
    store.pointerAt("b");
    c.advance(OPEN_AFTER_MS);
    expect(store.shown).toBe("b");
    store.typed();
    expect(store.shown).toBeNull();
    store.togglePin("a");
    store.typed();
    expect(store.getSnapshot()).toMatchObject({ shown: "a", pinned: true });
  });
});

describe("pinning a card (D67)", () => {
  test("the mark pins; its click again, Esc or an outside click unpins", () => {
    const { store, c } = setup();
    store.togglePin("a");
    expect(store.getSnapshot()).toMatchObject({ shown: "a", pinned: true, focus: false });
    // Hovering elsewhere neither moves nor closes it.
    store.pointerAt("b");
    c.advance(1000);
    store.pointerAt(null);
    c.advance(1000);
    expect(store.shown).toBe("a");
    store.togglePin("a");
    expect(store.shown).toBeNull();
    store.togglePin("a");
    store.unpin();
    expect(store.shown).toBeNull();
  });

  test("another pin moves it; Mod-. pins with the focus", () => {
    const { store } = setup();
    store.togglePin("a");
    store.pinFromKeyboard("b");
    expect(store.getSnapshot()).toMatchObject({ shown: "b", pinned: true, focus: true });
  });

  test("a card closed under the pointer does not keep later hover cards open", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(OPEN_AFTER_MS);
    store.pointerInCard(true);
    store.interact();
    // Esc while the pointer rests on the card: it closes, and no pointer leave comes.
    store.unpin();
    store.pointerAt("b");
    c.advance(OPEN_AFTER_MS);
    expect(store.shown).toBe("b");
    store.pointerAt(null);
    c.advance(CLOSE_AFTER_MS);
    expect(store.shown).toBeNull();
  });

  test("typing that closes a card under the pointer also forgets the pointer was in it", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(OPEN_AFTER_MS);
    store.pointerInCard(true);
    store.typed();
    store.pointerAt("b");
    c.advance(OPEN_AFTER_MS);
    store.pointerAt(null);
    c.advance(CLOSE_AFTER_MS);
    expect(store.shown).toBeNull();
  });

  test("acting in a hover card pins it", () => {
    const { store, c } = setup();
    store.pointerAt("a");
    c.advance(OPEN_AFTER_MS);
    store.interact();
    store.pointerAt(null);
    store.pointerInCard(false);
    c.advance(1000);
    expect(store.getSnapshot()).toMatchObject({ shown: "a", pinned: true });
  });

  test("the thread link pins its block's card and scrolls to it", () => {
    const { store } = setup();
    const revealed: string[] = [];
    store.reveal = (k) => void revealed.push(k);
    expect(store.pinThread("nope")).toBe(false);
    expect(store.pinThread("t1")).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ shown: "a", pinned: true });
    expect(revealed).toEqual(["a"]);
  });

  test("a block that is gone takes its card with it", () => {
    const { store } = setup();
    store.togglePin("a");
    store.setMarks(new Map([["b", mark("b")]]));
    expect(store.shown).toBeNull();
  });

  test("the anchor shows only for the open card", () => {
    const { store } = setup();
    store.togglePin("a");
    store.setAnchor(anchor("a"));
    expect(store.getSnapshot().anchor).toMatchObject({ key: "a", side: "right" });
    const before = store.getSnapshot();
    // The same place again: nothing re-renders.
    store.setAnchor(anchor("a"));
    expect(store.getSnapshot()).toBe(before);
    store.togglePin("b");
    expect(store.getSnapshot().anchor).toBeNull();
  });

  test("the same marks again do not re-render the card", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    store.setMarks(new Map(before.marks));
    expect(store.getSnapshot()).toBe(before);
  });
});

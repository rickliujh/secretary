/**
 * The note's hover cards (D67): which block the pointer is over, which card
 * is open, whether it is pinned, and where its anchor is. A plain store
 * outside React, so a hover or a pin re-renders only the card, never the
 * page. The editor reports the block under the pointer, typing, the marks and
 * the anchor's coordinates; the card reports the pointer entering or leaving
 * it and the user acting in it.
 *
 * Hover intent: a card opens about 180 ms after the pointer comes to rest
 * over a block's lines (pointer movement only, never typing), stays while the
 * pointer is on the block or the card, and closes about 150 ms after it left
 * both. Clicking the mark or Mod-. pins it; Esc, a click outside, or another
 * pin unpins. Clicking or focusing inside a hover card pins it, so a menu or
 * a dialog it opens, or a reply being typed, does not lose it. While a card
 * is pinned, hovering other blocks lights them but opens no card.
 */
import type { BlockMark } from "./block-marks";

export const OPEN_AFTER_MS = 180;
export const CLOSE_AFTER_MS = 150;

/** Where the card's anchor sits, relative to the editor's box. */
export type Anchor = {
  key: string;
  top: number;
  left: number;
  width: number;
  height: number;
  /** To the right of the text when the window has room, else below the block. */
  side: "right" | "bottom";
};

export type CardSnapshot = {
  /** Each block's mark by key, as of the editor's last update. */
  marks: ReadonlyMap<string, BlockMark>;
  /** The block under the pointer (its lines are lit). */
  hovered: string | null;
  /** The block whose card is open. */
  shown: string | null;
  pinned: boolean;
  /** Pinned from the keyboard: the card takes the focus. */
  focus: boolean;
  anchor: Anchor | null;
};

type Timers = {
  set: (f: () => void, ms: number) => unknown;
  clear: (t: unknown) => void;
};

const realTimers: Timers = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export class NoteCardStore {
  private marks: ReadonlyMap<string, BlockMark> = new Map();
  private hover: string | null = null;
  /** Opened by hover intent. */
  private open: string | null = null;
  private pin: string | null = null;
  private focus = false;
  private inCard = false;
  private anchor: Anchor | null = null;
  private openTimer: unknown = null;
  private closeTimer: unknown = null;
  private snapshot: CardSnapshot;
  private listeners = new Set<() => void>();
  /** Set by the editor: the lit blocks changed. */
  onLit: (keys: readonly string[]) => void = () => undefined;
  /** Set by the editor: puts the focus back in the text. */
  focusEditor: () => void = () => undefined;
  /** Set by the editor: scrolls a block into view. */
  reveal: (key: string) => void = () => undefined;

  constructor(private timers: Timers = realTimers) {
    this.snapshot = this.make();
  }

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  };
  getSnapshot = () => this.snapshot;

  /** The block whose card is open: the pinned one, else the one hover opened. */
  get shown() {
    return this.pin ?? this.open;
  }
  /** The blocks whose lines are lit: the hovered one and the one with the card. */
  get lit(): string[] {
    return [...new Set([this.hover, this.shown].filter((k): k is string => !!k))];
  }

  /** The pointer is over this block's lines, or over none (null). Pointer movement only. */
  pointerAt(key: string | null) {
    if (key === this.hover) return;
    this.hover = key;
    this.stop("open");
    if (key && !this.pin && key !== this.open)
      this.openTimer = this.timers.set(() => {
        this.openTimer = null;
        if (this.pin || this.hover !== key) return;
        this.stop("close");
        this.open = key;
        this.changed();
      }, OPEN_AFTER_MS);
    if (key && key === this.open) this.stop("close");
    else this.closeLater();
    this.changed();
  }

  /** The pointer entered (true) or left (false) the card. */
  pointerInCard(inside: boolean) {
    this.inCard = inside;
    if (inside) this.stop("close");
    else this.closeLater();
  }

  /** The user clicked or focused inside the card: a hover card stays until dismissed. */
  interact() {
    if (this.pin || !this.open) return;
    this.pin = this.open;
    this.open = null;
    this.changed();
  }

  /** The mark was clicked: pins its card, or unpins it when it is the pinned one. */
  togglePin(key: string) {
    if (this.pin === key) return this.unpin();
    this.pinTo(key, false);
  }

  /** Mod-. at the cursor: pins the block's card and gives it the focus. */
  pinFromKeyboard(key: string) {
    this.pinTo(key, true);
  }

  /** `/note?thread=<id>`: pins the card of that thread's block and scrolls to it. */
  pinThread(thread: string): boolean {
    const mark = [...this.marks.values()].find((m) => m.thread === thread);
    if (!mark) return false;
    this.pinTo(mark.key, false);
    this.reveal(mark.key);
    return true;
  }

  /** Esc, a click outside, or the mark of the pinned card: closes it. */
  unpin() {
    this.stop("open");
    this.stop("close");
    if (!this.pin && !this.open) return;
    this.pin = null;
    this.open = null;
    this.focus = false;
    this.changed();
  }

  /** The user typed in the note: no card opens from it, and a hover card closes. */
  typed() {
    this.stop("open");
    if (this.pin || !this.open) return;
    this.stop("close");
    this.open = null;
    this.changed();
  }

  setMarks(marks: ReadonlyMap<string, BlockMark>) {
    if (marks === this.marks) return;
    const before = this.marks;
    this.marks = marks;
    // A block that is gone takes its card and its light with it.
    if (this.pin && !marks.has(this.pin)) this.pin = null;
    if (this.open && !marks.has(this.open)) this.open = null;
    if (this.hover && !marks.has(this.hover)) this.hover = null;
    const same = before.size === marks.size && [...marks].every(([k, m]) => before.get(k) === m);
    if (!same || this.snapshot.shown !== this.shown || this.snapshot.hovered !== this.hover)
      this.changed();
  }

  setAnchor(anchor: Anchor | null) {
    const a = this.anchor;
    if (
      a === anchor ||
      (a &&
        anchor &&
        a.key === anchor.key &&
        a.top === anchor.top &&
        a.left === anchor.left &&
        a.width === anchor.width &&
        a.height === anchor.height &&
        a.side === anchor.side)
    )
      return;
    this.anchor = anchor;
    this.changed();
  }

  private pinTo(key: string, focus: boolean) {
    this.stop("open");
    this.stop("close");
    this.pin = key;
    this.open = null;
    this.focus = focus;
    this.changed();
  }

  /** A hover card closes a moment after the pointer left its block and the card. */
  private closeLater() {
    if (!this.open || this.pin || this.inCard || this.hover === this.open || this.closeTimer)
      return;
    this.closeTimer = this.timers.set(() => {
      this.closeTimer = null;
      if (this.pin || this.inCard || this.hover === this.open) return;
      this.open = null;
      this.changed();
    }, CLOSE_AFTER_MS);
  }

  private stop(which: "open" | "close") {
    const t = which === "open" ? this.openTimer : this.closeTimer;
    if (t !== null) this.timers.clear(t);
    if (which === "open") this.openTimer = null;
    else this.closeTimer = null;
  }

  private make(): CardSnapshot {
    const shown = this.shown;
    return {
      marks: this.marks,
      hovered: this.hover,
      shown,
      pinned: !!this.pin,
      focus: this.focus,
      anchor: this.anchor && this.anchor.key === shown ? this.anchor : null,
    };
  }

  private changed() {
    const before = this.snapshot;
    this.snapshot = this.make();
    // Another card, or none: the pointer is in no card now. A card closed under the
    // pointer (Esc, typing, its block gone) never sends its pointer leave.
    if (before.shown !== this.snapshot.shown) this.inCard = false;
    if (before.hovered !== this.snapshot.hovered || before.shown !== this.snapshot.shown)
      this.onLit(this.lit);
    for (const f of this.listeners) f();
  }
}

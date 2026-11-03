/**
 * The note editor's marks and hover (FR-20.7, D67) as a CodeMirror
 * extension: a gutter with one small mark on the first line of each block, a
 * faint background on the lines of the hovered block and of the block whose
 * card is open, and a view plugin that reports the block under the pointer
 * and the card's anchor (the block's first line, relative to the editor) to
 * the page's `NoteCardStore`. The page's data arrives by an effect into a
 * state field (it survives a reconfigure of the editor), and everything is
 * worked out from the editor's own text at every change, so it never points
 * past it. Blocks are followed through edits by their mapped ranges
 * (`block-marks.ts`), so a block being edited keeps its mark, and a pinned
 * card follows its block when lines above change. Clicking a mark pins its
 * card; Mod-. pins the card of the block at the cursor.
 */
import {
  type EditorState,
  type Extension,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type MarkState, markLabel } from "@/services/note/cards";
import {
  type BlockMark,
  blockAtLine,
  blockMarks,
  type Carry,
  emptyCards,
  type NoteCardsData,
  sameMark,
} from "./block-marks";
import type { Anchor, NoteCardStore } from "./card-store";

/** The room the card needs right of the text: its width, its gap (16) and the collision padding (12). */
export const CARD_ROOM = 360 + 16 + 12;

const svg = (body: string, fill = "none") =>
  `<svg viewBox="0 0 16 16" width="12" height="12" fill="${fill}" stroke="currentColor" aria-hidden="true">${body}</svg>`;
const ICONS = {
  check: svg(`<path d="M3 8.5l3 3 7-7" stroke-width="2.2"/>`),
  note: svg(
    `<path d="M3 2h8l2 2v10H3z" fill="currentColor" opacity=".25" stroke="none"/><path d="M5 7h6M5 10h6" stroke-width="1.5"/>`,
  ),
  lock: svg(
    `<rect x="3" y="7" width="10" height="7" rx="1.5" stroke-width="1.6"/><path d="M5 7V5a3 3 0 016 0v2" stroke-width="1.6"/>`,
  ),
};

/** The mark's face: its look (a CSS class), its text or icon. */
export function markFace(state: MarkState): { look: string; text: string; icon: string | null } {
  switch (state.kind) {
    case "waiting":
      return { look: "waiting", text: state.count > 9 ? "9+" : String(state.count), icon: null };
    case "question":
      return { look: "question", text: "?", icon: null };
    case "failed":
      return { look: "failed", text: "!", icon: null };
    case "done":
      return { look: "done", text: "", icon: ICONS.check };
    case "noted":
      return { look: "noted", text: "", icon: ICONS.note };
    case "private":
      return { look: "private", text: "", icon: ICONS.lock };
    case "unread":
      return { look: "unread", text: "", icon: null };
    case "not_read":
    case "alone":
    case "loading":
      return { look: "ghost", text: "·", icon: null };
  }
}

class MarkMarker extends GutterMarker {
  constructor(
    readonly key: string,
    readonly state: MarkState,
    /** Its block is hovered or its card is open: a quiet mark shows. */
    readonly lit: boolean,
    readonly store: NoteCardStore,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return (
      other instanceof MarkMarker &&
      other.key === this.key &&
      other.lit === this.lit &&
      markLabel(other.state) === markLabel(this.state)
    );
  }
  override toDOM() {
    const face = markFace(this.state);
    const el = document.createElement("button");
    el.type = "button";
    el.className = `cm-note-mark cm-note-mark-${face.look}${this.lit ? " cm-note-mark-lit" : ""}`;
    const label = markLabel(this.state);
    el.setAttribute("aria-label", `This line: ${label}. Show its card`);
    el.title = label;
    if (face.icon) el.innerHTML = face.icon;
    else el.textContent = face.text;
    // The text keeps the focus and the selection; the click pins the card.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => this.store.togglePin(this.key));
    return el;
  }
}

/** Keeps the gutter as wide as a mark when the note has none. */
class SpacerMarker extends GutterMarker {
  override toDOM() {
    const el = document.createElement("span");
    el.className = "cm-note-mark";
    return el;
  }
}

/** Sets what the page knows of the day's blocks. */
export const setNoteCards = StateEffect.define<NoteCardsData>();
/** Sets the lit blocks: the hovered one and the one whose card is open. */
export const setLit = StateEffect.define<readonly string[]>();

export type CardsState = {
  data: NoteCardsData;
  marks: readonly BlockMark[];
  carries: readonly Carry[];
  lit: readonly string[];
  decos: DecorationSet;
  markers: RangeSet<GutterMarker>;
};

const litLine = Decoration.line({ class: "cm-note-lit" });

function paint(
  state: EditorState,
  marks: readonly BlockMark[],
  lit: readonly string[],
  store: NoteCardStore,
) {
  const doc = state.doc;
  const lineAt = (n: number) => doc.line(Math.min(n + 1, doc.lines));
  const markers = RangeSet.of<GutterMarker>(
    marks.map((m) =>
      new MarkMarker(m.key, m.state, lit.includes(m.key), store).range(lineAt(m.line).from),
    ),
    true,
  );
  const lines = marks
    .filter((m) => lit.includes(m.key))
    .flatMap((m) => {
      const out = [];
      for (let n = m.line; n <= m.toLine && n < doc.lines; n++)
        out.push(litLine.range(lineAt(n).from));
      return out;
    });
  return { markers, decos: Decoration.set(lines, true) };
}

function build(
  state: EditorState,
  data: NoteCardsData,
  carries: readonly Carry[],
  lit: readonly string[],
  store: NoteCardStore,
): CardsState {
  const out = blockMarks(state.doc.toString(), data, carries);
  return {
    data,
    marks: out.marks,
    carries: out.carries,
    lit,
    ...paint(state, out.marks, lit, store),
  };
}

/** The block whose lines hold the cursor. */
export function markAtCursor(state: EditorState, marks: readonly BlockMark[]) {
  return blockAtLine(marks, state.doc.lineAt(state.selection.main.head).number - 1);
}

/** The block under a point of the screen; null outside the note's lines. */
export function markAtY(view: EditorView, marks: readonly BlockMark[], clientY: number) {
  const y = clientY - view.documentTop;
  if (y < 0 || y > view.contentHeight) return null;
  const line = view.state.doc.lineAt(view.lineBlockAtHeight(y).from).number - 1;
  return blockAtLine(marks, line);
}

/** The state field alone (tests): what `noteCards` adds with its gutter and plugin. */
export function noteCardsField(store: NoteCardStore) {
  return StateField.define<CardsState>({
    create: (state) => build(state, emptyCards, [], [], store),
    update(value, tr) {
      let data = value.data;
      let lit = value.lit;
      for (const e of tr.effects) {
        if (e.is(setNoteCards)) data = e.value;
        if (e.is(setLit)) lit = e.value;
      }
      if (data === value.data && !tr.docChanged) {
        if (lit === value.lit) return value;
        return { ...value, lit, ...paint(tr.state, value.marks, lit, store) };
      }
      // Each block's range follows the change: an edited block is still itself.
      const carries = tr.docChanged
        ? value.carries.map((c) => ({
            ...c,
            from: tr.changes.mapPos(c.from, -1),
            to: tr.changes.mapPos(c.to, 1),
          }))
        : value.carries;
      return build(tr.state, data, carries, lit, store);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });
}

/** Typed, pasted or deleted by the user (not a sync, not the chat's append). */
const byUser = (u: ViewUpdate) =>
  u.docChanged && u.transactions.some((tr) => tr.annotation(Transaction.userEvent) !== undefined);

/** The extension, for one editor and its store. */
export function noteCards(store: NoteCardStore): Extension {
  const field = noteCardsField(store);
  const hover = ViewPlugin.define((view) => {
    let destroyed = false;
    let published = new Map<string, BlockMark>();
    const marks = () => view.state.field(field).marks;
    const publish = () => {
      published = new Map(marks().map((m) => [m.key, sameMark(published.get(m.key), m)]));
      store.setMarks(published);
    };
    // CodeMirror hides its gutters from assistive tech; this one holds the marks' buttons.
    const show = () => view.dom.querySelector(".cm-gutters")?.removeAttribute("aria-hidden");

    /** Where the open card's block is, for its anchor. */
    const measure = () => {
      const key = store.shown;
      if (!key) return store.setAnchor(null);
      view.requestMeasure<Anchor | null>({
        key: measure,
        read(v) {
          const m = v.state.field(field).marks.find((x) => x.key === key);
          if (!m) return null;
          const doc = v.state.doc;
          const first = doc.line(Math.min(m.line + 1, doc.lines));
          const last = doc.line(Math.min(m.toLine + 1, doc.lines));
          const top = v.lineBlockAt(first.from).top;
          const bottom = v.lineBlockAt(last.to).bottom;
          const box = v.dom.getBoundingClientRect();
          const text = v.contentDOM.getBoundingClientRect();
          return {
            key,
            top: v.documentTop - box.top + top,
            left: text.left - box.left,
            width: text.width,
            height: bottom - top,
            side: window.innerWidth - text.right >= CARD_ROOM ? "right" : "bottom",
          };
        },
        write: (a) => store.setAnchor(a),
      });
    };

    const onMove = (e: MouseEvent) =>
      store.pointerAt(markAtY(view, marks(), e.clientY)?.key ?? null);
    const onLeave = () => store.pointerAt(null);
    view.dom.addEventListener("mousemove", onMove);
    view.dom.addEventListener("mouseleave", onLeave);
    window.addEventListener("resize", measure);

    store.onLit = (keys) =>
      // The store may change inside an editor update (typing closes a card): dispatch after it.
      queueMicrotask(() => {
        if (!destroyed) view.dispatch({ effects: setLit.of(keys) });
      });
    store.focusEditor = () => view.focus();
    // Store callbacks may run inside an editor update (a mark first published there):
    // never dispatch from them directly.
    store.reveal = (key) =>
      queueMicrotask(() => {
        if (destroyed) return;
        const m = marks().find((x) => x.key === key);
        if (!m) return;
        const pos = view.state.doc.line(Math.min(m.line + 1, view.state.doc.lines)).from;
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      });
    publish();
    show();
    return {
      update(u) {
        const now = u.state.field(field);
        if (now.marks !== u.startState.field(field).marks) publish();
        if (byUser(u)) store.typed();
        show();
        if (
          u.docChanged ||
          u.geometryChanged ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(setLit) || e.is(setNoteCards)))
        )
          measure();
      },
      destroy() {
        destroyed = true;
        view.dom.removeEventListener("mousemove", onMove);
        view.dom.removeEventListener("mouseleave", onLeave);
        window.removeEventListener("resize", measure);
        store.onLit = () => undefined;
        store.focusEditor = () => undefined;
        store.reveal = () => undefined;
        // The card belongs to this editor (this day): it goes with it.
        store.pointerAt(null);
        store.unpin();
      },
    };
  });
  return [
    field,
    gutter({
      class: "cm-note-marks",
      markers: (view) => view.state.field(field).markers,
      initialSpacer: () => new SpacerMarker(),
    }),
    hover,
    Prec.high(
      keymap.of([
        {
          key: "Mod-.",
          run: (view) => {
            const m = markAtCursor(view.state, view.state.field(field).marks);
            if (!m) return false;
            store.pinFromKeyboard(m.key);
            return true;
          },
        },
      ]),
    ),
  ];
}

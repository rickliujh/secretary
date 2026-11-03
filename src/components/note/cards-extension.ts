/**
 * The note editor's marks and strips (FR-20.7, D67) as a CodeMirror
 * extension: a gutter with one marker on the first line of each block (an
 * invisible one on blocks not read yet, for Ask) and a one-line block widget
 * under each block with a conversation or a work item note. The page's data
 * arrives by an effect into a state field (it survives a reconfigure of the
 * editor), and the decorations are worked out from the editor's own text at
 * every change, so they never point past it. Blocks are followed through
 * edits by their mapped ranges (`block-marks.ts`), so a block being edited
 * keeps its marker and strip. Markers and widgets make empty DOM nodes,
 * keyed by block only, and register them in a `SlotStore`; the page renders
 * the app's components into them with portals and reads each block's state
 * from the store. Mod-. opens the menu of the block at the cursor.
 */
import {
  type EditorState,
  type Extension,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import {
  type BlockMark,
  blockMarks,
  type Carry,
  emptyCards,
  type NoteCardsData,
} from "./block-marks";

export type Slot = {
  /** Unique per node, for React's keys. */
  id: number;
  kind: "mark" | "strip";
  /** The block's key: its state is `marks.get(key)`. */
  key: string;
  el: HTMLElement;
};

export type SlotSnapshot = {
  slots: readonly Slot[];
  /** Each block's mark, by key, as of the editor's last update. */
  marks: ReadonlyMap<string, BlockMark>;
};

/** The DOM nodes the editor made for marks and strips, and the blocks' state, for the page. */
export class SlotStore {
  private slots = new Map<HTMLElement, Slot>();
  private marks: ReadonlyMap<string, BlockMark> = new Map();
  private snapshot: SlotSnapshot = { slots: [], marks: this.marks };
  private listeners = new Set<() => void>();
  private openers = new Set<(key: string) => void>();
  private queued = false;
  private next = 0;
  /** Set by the editor: puts the focus back in the text. */
  focusEditor: () => void = () => undefined;

  add(slot: Omit<Slot, "id">) {
    this.slots.set(slot.el, { ...slot, id: this.next++ });
    this.changed();
  }
  remove(el: HTMLElement) {
    if (this.slots.delete(el)) this.changed();
  }
  setMarks(marks: ReadonlyMap<string, BlockMark>) {
    this.marks = marks;
    this.changed();
  }
  /** Asks the page to open a block's menu (the Mod-. command). */
  open(key: string) {
    for (const f of this.openers) f(key);
  }
  onOpen = (f: (key: string) => void) => {
    this.openers.add(f);
    return () => void this.openers.delete(f);
  };
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  };
  getSnapshot = () => this.snapshot;
  /** Batched: the editor may make many nodes in one update, inside React's commit. */
  private changed() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.snapshot = { slots: [...this.slots.values()], marks: this.marks };
      for (const f of this.listeners) f();
    });
  }
}

/** The marker's node depends on the block only; its look is the page's (React) content. */
class MarkMarker extends GutterMarker {
  constructor(
    readonly key: string,
    readonly store: SlotStore,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof MarkMarker && other.key === this.key;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = "cm-note-mark";
    this.store.add({ kind: "mark", key: this.key, el });
    return el;
  }
  override destroy(dom: Node) {
    this.store.remove(dom as HTMLElement);
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

/** One line high: the editor knows its height before the page fills it. */
export const STRIP_HEIGHT = 28;

class StripWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly store: SlotStore,
  ) {
    super();
  }
  override eq(other: WidgetType) {
    return other instanceof StripWidget && other.key === this.key;
  }
  override get estimatedHeight() {
    return STRIP_HEIGHT;
  }
  override toDOM() {
    const el = document.createElement("div");
    el.className = "cm-note-strip";
    el.style.height = `${STRIP_HEIGHT}px`;
    this.store.add({ kind: "strip", key: this.key, el });
    return el;
  }
  override destroy(dom: HTMLElement) {
    this.store.remove(dom);
  }
}

/** Sets what the page knows of the day's blocks. */
export const setNoteCards = StateEffect.define<NoteCardsData>();

export type CardsState = {
  data: NoteCardsData;
  marks: readonly BlockMark[];
  carries: readonly Carry[];
  decos: DecorationSet;
  markers: RangeSet<GutterMarker>;
};

function build(
  state: EditorState,
  data: NoteCardsData,
  carries: readonly Carry[],
  store: SlotStore,
): CardsState {
  const doc = state.doc;
  const out = blockMarks(doc.toString(), data, carries);
  const lineAt = (n: number) => doc.line(Math.min(n + 1, doc.lines));
  const markers = RangeSet.of<GutterMarker>(
    out.marks.map((m) => new MarkMarker(m.key, store).range(lineAt(m.line).from)),
    true,
  );
  const decos = Decoration.set(
    out.marks
      .filter((m) => m.strip)
      .map((m) =>
        Decoration.widget({ widget: new StripWidget(m.key, store), block: true, side: 1 }).range(
          lineAt(m.toLine).to,
        ),
      ),
    true,
  );
  return { data, marks: out.marks, carries: out.carries, decos, markers };
}

/**
 * The published mark when nothing the page shows changed (its lines may have
 * moved), so the page's memoised menus and strips skip a keystroke elsewhere.
 */
function sameMark(before: BlockMark | undefined, now: BlockMark): BlockMark {
  if (!before) return now;
  const same =
    before.hash === now.hash &&
    before.row === now.row &&
    before.status === now.status &&
    before.changed === now.changed &&
    before.private === now.private &&
    before.thread === now.thread &&
    before.waits === now.waits &&
    before.strip === now.strip;
  return same ? before : now;
}

/** The block whose lines hold the cursor. */
export function markAtCursor(state: EditorState, marks: readonly BlockMark[]) {
  const line = state.doc.lineAt(state.selection.main.head).number - 1;
  return marks.find((m) => m.line <= line && line <= m.toLine) ?? null;
}

/** The state field alone (tests): what `noteCards` adds with its gutter and plugins. */
export function noteCardsField(store: SlotStore) {
  return StateField.define<CardsState>({
    create: (state) => build(state, emptyCards, [], store),
    update(value, tr) {
      let data = value.data;
      for (const e of tr.effects) if (e.is(setNoteCards)) data = e.value;
      if (data === value.data && !tr.docChanged) return value;
      // Each block's range follows the change: an edited block is still itself.
      const carries = tr.docChanged
        ? value.carries.map((c) => ({
            ...c,
            from: tr.changes.mapPos(c.from, -1),
            to: tr.changes.mapPos(c.to, 1),
          }))
        : value.carries;
      return build(tr.state, data, carries, store);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });
}

/** The extension, for one editor and its store. */
export function noteCards(store: SlotStore): Extension {
  const field = noteCardsField(store);
  const publish = ViewPlugin.define((view) => {
    const show = () => {
      // CodeMirror hides its gutters from assistive tech; this one holds the menus.
      view.dom.querySelector(".cm-gutters")?.removeAttribute("aria-hidden");
    };
    store.focusEditor = () => view.focus();
    let published = new Map<string, BlockMark>();
    const publishMarks = (marks: readonly BlockMark[]) => {
      published = new Map(marks.map((m) => [m.key, sameMark(published.get(m.key), m)]));
      store.setMarks(published);
    };
    publishMarks(view.state.field(field).marks);
    show();
    return {
      update(u) {
        const now = u.state.field(field);
        if (now !== u.startState.field(field)) publishMarks(now.marks);
        show();
      },
      destroy() {
        store.focusEditor = () => undefined;
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
    publish,
    Prec.high(
      keymap.of([
        {
          key: "Mod-.",
          run: (view) => {
            const m = markAtCursor(view.state, view.state.field(field).marks);
            if (!m) return false;
            store.open(m.key);
            return true;
          },
        },
      ]),
    ),
  ];
}

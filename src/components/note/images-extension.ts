/**
 * Images in the note's editor (D70, FR-20.9). Pasting or dropping image files
 * saves each through `io.save` (NoteFile.saveImage: where Obsidian would put
 * it, or the app's data folder) and inserts the link it returns on its own
 * line at the cursor; a failed save goes to `io.failed` (a toast) and inserts
 * nothing. A text paste is left to the editor. Every line that holds image
 * links shows each image under it as a block widget; the widget's identity
 * is its link, so typing on the line does not reload it. Loaded images are
 * kept for the session as data URLs; `invalidateNoteImages` (Read now) drops
 * them and redraws. The link is text in the note like any other: nothing
 * here changes what the reading sees, and no image ever reaches a model.
 */
import { type Extension, type Range, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { type ImageLink, imageLinks, insertImageLink } from "@/services/note/images";

/** How the editor reaches the files; the page's is in `images-io.ts`, tests pass their own. */
export type NoteImagesIO = {
  /** Saves an image and returns the link text to insert; rejects when it was not saved. */
  save: (data: Uint8Array, ext: string) => Promise<string>;
  /** A data URL for a link's target; null when the image is not found. */
  load: (target: string) => Promise<string | null>;
  /** A save failed: tell the user. */
  failed: (error: unknown) => void;
  /** A save finished after the editor closed or turned read-only: the file exists, unlinked. */
  notLinked: (link: string) => void;
};

/** The image types a browser gives on paste or drop, and the extension each is saved with. */
const SAVED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// ---------------------------------------------------------------------------
// The per-session cache of loaded images
// ---------------------------------------------------------------------------

/** At most this many images, and this many characters of data URLs, are kept. */
export const CACHED_IMAGES = 40;
export const CACHED_CHARS = 64 * 1024 * 1024;

type Cached = { loading: Promise<string | null | undefined>; chars: number };
/**
 * Per target, least recently used first: a data URL, null (not found), or
 * undefined (it cannot be read now).
 */
const cache = new Map<string, Cached>();
let cachedChars = 0;
const listeners = new Set<() => void>();

function evict() {
  for (const [target, entry] of cache) {
    if (cache.size <= CACHED_IMAGES && cachedChars <= CACHED_CHARS) return;
    cache.delete(target);
    cachedChars -= entry.chars;
  }
}

/**
 * The image for a target, loaded once and kept while it is among the recently
 * used (40 images, 64 MB of data URLs); a failed load is not kept.
 */
export function loadNoteImage(
  io: NoteImagesIO,
  target: string,
): Promise<string | null | undefined> {
  const hit = cache.get(target);
  if (hit) {
    // Most recently used goes last.
    cache.delete(target);
    cache.set(target, hit);
    return hit.loading;
  }
  const entry: Cached = { loading: Promise.resolve(undefined), chars: 0 };
  entry.loading = io.load(target).then(
    (url) => {
      if (cache.get(target) === entry && url) {
        entry.chars = url.length;
        cachedChars += entry.chars;
        evict();
      }
      return url;
    },
    () => {
      // A closed Obsidian or a failed read: no image now, try again next time.
      if (cache.get(target) === entry) cache.delete(target);
      return undefined;
    },
  );
  cache.set(target, entry);
  evict();
  return entry.loading;
}

/** Drops every loaded image (Read now) and redraws the editors' images. */
export function invalidateNoteImages() {
  cache.clear();
  cachedChars = 0;
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// The widgets
// ---------------------------------------------------------------------------

const refreshImages = StateEffect.define<null>();

class ImageWidget extends WidgetType {
  constructor(
    readonly link: ImageLink,
    readonly generation: number,
    readonly io: NoteImagesIO,
  ) {
    super();
  }

  override eq(other: ImageWidget) {
    return other.link.target === this.link.target && other.generation === this.generation;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-note-image";
    box.dataset.target = this.link.target;
    void loadNoteImage(this.io, this.link.target).then((url) => {
      if (url === undefined) return;
      if (url === null) {
        const missing = document.createElement("span");
        missing.className = "cm-note-image-missing";
        missing.textContent = `Image not found: ${this.link.name}`;
        box.append(missing);
      } else {
        const img = document.createElement("img");
        img.alt = this.link.name;
        img.src = url;
        img.addEventListener("load", () => view.requestMeasure());
        box.append(img);
      }
      view.requestMeasure();
    });
    return box;
  }

  override ignoreEvent() {
    return true;
  }
}

function imageDecorations(doc: Text, generation: number, io: NoteImagesIO): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.includes("![")) continue;
    for (const link of imageLinks(line.text))
      out.push(
        Decoration.widget({
          widget: new ImageWidget(link, generation, io),
          block: true,
          side: 1,
        }).range(line.to),
      );
  }
  return Decoration.set(out);
}

// ---------------------------------------------------------------------------
// Paste and drop
// ---------------------------------------------------------------------------

/** The largest image saved, as Rust caps it, with Rust's words. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TOO_LARGE = "the image is larger than 20 MB";

/** The image files of a paste or drop, with the extension each is saved with. */
function imageFiles(files: FileList | undefined | null): { file: File; ext: string }[] {
  const out: { file: File; ext: string }[] = [];
  for (const file of files ? Array.from(files) : []) {
    const ext = SAVED_TYPES[file.type];
    if (ext) out.push({ file, ext });
  }
  return out;
}

/** HTML that is one `<img>` and nothing else to read (a browser's "Copy image"). */
function singleImage(html: string): boolean {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return body.querySelectorAll("img").length === 1 && !body.textContent?.trim();
}

/**
 * Whether a clipboard with an image is a text paste after all: Excel, Word or
 * PowerPoint put a picture of the copied cells or text next to the text, and
 * the user meant the text. A browser's copied image (HTML of one `<img>`) is
 * an image.
 */
export function pasteIsText(plain: string, html: string): boolean {
  if (!plain.trim() && !html.trim()) return false;
  return !(html.trim() && singleImage(html));
}

const editable = (view: EditorView) =>
  !view.state.readOnly && view.state.facet(EditorView.editable);

/**
 * Saves the files one by one and inserts each link at the cursor; stops at
 * the first failure. A file over the cap is refused before it is read. When
 * the editor is gone or read-only by the time a save finishes (the day
 * changed), the image stays saved and the user is told it is not linked.
 */
async function saveAll(view: EditorView, io: NoteImagesIO, files: { file: File; ext: string }[]) {
  for (const { file, ext } of files) {
    let link: string;
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(TOO_LARGE);
      link = await io.save(new Uint8Array(await file.arrayBuffer()), ext);
    } catch (error) {
      io.failed(error);
      return;
    }
    if (!view.dom.isConnected || !editable(view)) {
      io.notLinked(link);
      return;
    }
    const at = view.state.selection.main.head;
    const { changes, cursor } = insertImageLink(view.state.doc.toString(), at, link);
    view.dispatch({
      changes,
      selection: { anchor: cursor },
      userEvent: "input.paste",
      scrollIntoView: true,
    });
  }
}

/** The images in the note: paste and drop to save, a widget under each linked line. */
export function noteImages(io: NoteImagesIO): Extension {
  const field = StateField.define<{ generation: number; decorations: DecorationSet }>({
    create: (state) => ({ generation: 0, decorations: imageDecorations(state.doc, 0, io) }),
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(refreshImages));
      if (!refresh && !tr.docChanged) return value;
      const generation = value.generation + (refresh ? 1 : 0);
      return { generation, decorations: imageDecorations(tr.state.doc, generation, io) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });

  // Hears Read now's invalidation while the editor is open.
  const refresher = ViewPlugin.define((view) => {
    const listener = () => view.dispatch({ effects: refreshImages.of(null) });
    listeners.add(listener);
    return { destroy: () => listeners.delete(listener) };
  });

  const handlers = EditorView.domEventHandlers({
    paste(event, view) {
      if (!editable(view)) return false;
      const data = event.clipboardData;
      const files = imageFiles(data?.files);
      // Text (or anything without an image) pastes as it always did.
      if (files.length === 0) return false;
      if (pasteIsText(data?.getData("text/plain") ?? "", data?.getData("text/html") ?? ""))
        return false;
      event.preventDefault();
      void saveAll(view, io, files);
      return true;
    },
    drop(event, view) {
      if (!editable(view)) return false;
      const files = imageFiles(event.dataTransfer?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (at !== null) view.dispatch({ selection: { anchor: at } });
      void saveAll(view, io, files);
      return true;
    },
  });

  return [field, refresher, handlers];
}

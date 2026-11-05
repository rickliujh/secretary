/**
 * The Note page's editor state (D65): the text loads once per day, saves 500 ms
 * after the last keystroke (no model call), and the note is read 60 s after
 * the last keystroke while the page is open. A save is a compare-and-swap on
 * the body the page last loaded: when a sync or the chat changed the stored
 * note since, the page's edits are merged onto it and the page shows the
 * result, so nothing written elsewhere is saved over. With a vault chosen, the
 * file of record is synced when the page opens (starting Obsidian if needed),
 * when the window regains focus and every 30 s (never starting it); text typed
 * while a sync ran is merged onto its result. A page left open past midnight
 * moves to the new day on focus or the next poll. Webview timers only: nothing
 * runs once the page or the app is closed.
 */
import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { toastError } from "@/app/errors";
import { noteChanged, noteTyped, readNoteNow } from "@/app/note";
import { run } from "@/app/runtime";
import { requestWorkPass } from "@/app/work";
import { localDate } from "@/lib/dates";
import { DailyNote, type SyncStatus } from "@/services/note";
import { mergeNote } from "@/services/note/merge";
import { invalidateNoteImages } from "./images-extension";

const SAVE_AFTER_MS = 500;
const READ_AFTER_MS = 60_000;
const POLL_MS = 30_000;

export function useNoteEditor(
  date: string,
  editable: boolean,
  synced: boolean,
  /** Called when today's page is open and the local day has changed. */
  onNewDay: () => void = () => undefined,
) {
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  /** Both sides changed the same lines at some sync; shown until dismissed. */
  const [conflict, setConflict] = useState(false);
  const live = useRef({ date, editable, synced, onNewDay });
  live.current = { date, editable, synced, onNewDay };
  const current = useRef<string | null>(null);
  /** The body known to be stored: the base of the next save's compare-and-swap. */
  const saved = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);
  /** The day the text on screen belongs to, so leaving a day saves to that day. */
  const shownFor = useRef<{ date: string; editable: boolean } | null>(null);

  const show = useCallback((t: string) => {
    current.current = t;
    setText(t);
  }, []);

  /** Puts a stored body on screen; keystrokes made since `typed` was sent go onto it. */
  const adopt = useCallback(
    (stored: string, typed: string | null) => {
      saved.current = stored;
      const now = current.current;
      if (now === typed || now === null) {
        show(stored);
        return false;
      }
      const m = mergeNote(typed ?? "", now, stored);
      show(m.text);
      if (m.conflict) setConflict(true);
      return m.text !== stored;
    },
    [show],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const owner = shownFor.current;
    const t = current.current;
    if (!owner?.editable || t === null || t === saved.current) return;
    const d = await run(Effect.flatMap(DailyNote, (n) => n.save(owner.date, t, saved.current)));
    if (shownFor.current !== owner) return;
    // The stored note changed under the page: the merge is what was saved.
    if (adopt(d.body, t)) await flush();
  }, [adopt]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void flush().catch((e) => toastError(e, { retry: () => void flush() })),
      SAVE_AFTER_MS,
    );
  }, [flush]);

  /**
   * With a vault: merge with the file of record (`launch` starts Obsidian when
   * it is closed). Without: reload when nothing is unsaved.
   */
  const refresh = useCallback(
    async (launch = false) => {
      const { date: day, editable: canEdit, synced: withVault } = live.current;
      if (canEdit && day !== localDate()) {
        live.current.onNewDay();
        return;
      }
      if (syncing.current) return;
      syncing.current = true;
      try {
        if (canEdit && withVault) {
          await flush();
          const before = current.current;
          const st = await run(Effect.flatMap(DailyNote, (n) => n.sync({ launch })));
          setStatus(st);
          if (st.state !== "synced") return;
          if (st.conflict) setConflict(true);
          const d = await run(Effect.flatMap(DailyNote, (n) => n.load(day)));
          if (live.current.date !== day) return;
          // Typed while the sync ran: those keystrokes go onto the synced text.
          if (adopt(d.body, before)) scheduleSave();
          noteChanged();
        } else if (current.current === saved.current) {
          const d = await run(Effect.flatMap(DailyNote, (n) => n.load(day)));
          if (live.current.date === day && current.current === saved.current) adopt(d.body, null);
        }
      } catch (e) {
        toastError(e);
      } finally {
        syncing.current = false;
      }
    },
    [flush, adopt, scheduleSave],
  );

  // Load the day; leaving it saves what is unsaved.
  useEffect(() => {
    let alive = true;
    setText(null);
    current.current = null;
    shownFor.current = null;
    void run(Effect.flatMap(DailyNote, (n) => n.load(date)))
      .then((d) => {
        if (!alive) return;
        shownFor.current = { date: d.date, editable: d.editable };
        saved.current = d.body;
        show(d.body);
        // Opening the page may start Obsidian; the poll and focus never do.
        void refresh(true);
      })
      .catch((e) => toastError(e));
    return () => {
      alive = false;
      void flush().catch(() => undefined);
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = null;
    };
  }, [date, show, refresh, flush]);

  // The file of record on focus and every 30 s while the page is open.
  useEffect(() => {
    const onFocus = () => void refresh(false);
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => void refresh(false), POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [refresh]);

  const onChange = useCallback(
    (t: string) => {
      if (!live.current.editable) return;
      noteTyped();
      show(t);
      scheduleSave();
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = setTimeout(() => {
        readTimer.current = null;
        void flush()
          .then(() => readNoteNow("typing", requestWorkPass))
          .catch(() => undefined);
      }, READ_AFTER_MS);
    },
    [show, scheduleSave, flush],
  );

  const readNow = useCallback(async () => {
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = null;
    await flush();
    const r = await readNoteNow("button", requestWorkPass);
    // Read now synced the file of record (starting Obsidian if needed): show it,
    // and its images afresh (D70).
    invalidateNoteImages();
    void refresh(false);
    return r;
  }, [flush, refresh]);

  return {
    text,
    onChange,
    status,
    conflict,
    dismissConflict: () => setConflict(false),
    readNow,
    refresh,
    /** Saves what is unsaved now, so the stored note is what the page shows (D67's Ask). */
    flush,
  };
}

/**
 * The marks' menus and the strips (D67), rendered by portal into the nodes
 * the editor made for them. Its own component, memoised on props that do not
 * change as the user types, so a keystroke re-renders only what the editor's
 * store says changed.
 */
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ThreadSummary } from "@/services/note/cards";
import { BlockMarkMenu, ContextStrip, ThreadStrip } from "./block-strip";
import type { SlotStore } from "./cards-extension";

export const CardsLayer = memo(function CardsLayer({
  slots,
  threads,
  onOpen,
  onAsk,
  askingHash,
}: {
  slots: SlotStore;
  threads: ReadonlyMap<string, ThreadSummary>;
  onOpen: (thread: string) => void;
  onAsk: (hash: string) => void;
  /** The block Ask runs on; null when none does. */
  askingHash: string | null;
}) {
  const { slots: list, marks } = useSyncExternalStore(slots.subscribe, slots.getSnapshot);
  // The open menu, by block. Opened from the text (Mod-.), it gives the focus back to the text.
  const [open, setOpen] = useState<string | null>(null);
  const fromText = useRef(false);
  useEffect(
    () =>
      slots.onOpen((key) => {
        fromText.current = true;
        setOpen(key);
      }),
    [slots],
  );
  const onOpenChange = useCallback((key: string, o: boolean) => {
    if (o) fromText.current = false;
    setOpen((now) => (o ? key : now === key ? null : now));
  }, []);
  const onCloseFocus = useCallback(
    (e: Event) => {
      if (!fromText.current) return;
      fromText.current = false;
      e.preventDefault();
      slots.focusEditor();
    },
    [slots],
  );
  return list.map((s) => {
    const mark = marks.get(s.key);
    if (!mark) return null;
    if (s.kind === "mark")
      return createPortal(
        <BlockMarkMenu
          mark={mark}
          open={open === s.key}
          onOpenChange={onOpenChange}
          asking={askingHash === mark.hash}
          askBusy={askingHash !== null}
          onOpen={onOpen}
          onAsk={onAsk}
          onCloseFocus={onCloseFocus}
        />,
        s.el,
        s.id,
      );
    const summary = mark.thread ? threads.get(mark.thread) : undefined;
    if (summary)
      return createPortal(
        <ThreadStrip thread={summary} changed={mark.changed} onOpen={onOpen} />,
        s.el,
        s.id,
      );
    if (mark.strip === "context")
      return createPortal(
        <ContextStrip name={mark.row?.workItemName ?? null} changed={mark.changed} />,
        s.el,
        s.id,
      );
    return null;
  });
});

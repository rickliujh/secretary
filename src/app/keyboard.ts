/** App-wide keys (D38). */
import { useEffect } from "react";
import { deleteWordInFocused } from "@/lib/delete-word";
import { isMac } from "./platform";

/**
 * Ctrl+W deletes the previous word instead of closing the window. On macOS
 * Cmd+W does the same, for keyboards that swap Control and Command.
 */
export function useDeleteWordKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "w" || e.altKey || e.shiftKey || e.isComposing) return;
      const mod = e.ctrlKey !== (isMac && e.metaKey);
      if (!mod || (e.ctrlKey && e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      deleteWordInFocused();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}

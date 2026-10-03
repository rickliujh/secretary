/**
 * Quick capture (design.md D48): the Capture dialog's state, what the native side
 * reported, and the submit path. Kept free of Tauri calls so tests can drive it;
 * `capture-native.ts` connects it to the window, the tray and the shortcut.
 */
import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { TriageInput, TriageResult } from "@/services/intake";

/** Emitted by the Rust side for the tray, the global shortcut and `--capture`. */
export const OPEN_CAPTURE_EVENT = "capture://open";

/** How to put the window back after capture: it was hidden, minimised, or already open. */
export type Restore = "hide" | "minimize" | null;

const OpenCapturePayload = z
  .object({ restore: z.enum(["hide", "minimize"]).nullable().catch(null) })
  .catch({ restore: null });

/** What the desktop side reported at startup; null until then and in a plain browser. */
export type NativeCapture = { tray: boolean; trayError: string | null; wayland: boolean };

/** The last shortcut registration: what is registered, or why nothing is. */
export type ShortcutResult = { registered: string | null; error: string | null };

type CaptureState = {
  open: boolean;
  restore: Restore;
  native: NativeCapture | null;
  shortcut: ShortcutResult | null;
};

let state: CaptureState = { open: false, restore: null, native: null, shortcut: null };
const listeners = new Set<() => void>();

function set(patch: Partial<CaptureState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const captureStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Opens the dialog; `restore` says what to do with the window when it closes. */
  open: (restore: Restore = null) =>
    set({ open: true, restore: state.open ? state.restore : restore }),
  close: () => set({ open: false, restore: null }),
  setNative: (native: NativeCapture) => set({ native }),
  setShortcut: (shortcut: ShortcutResult) => set({ shortcut }),
};

export const openCapture = (restore: Restore = null) => captureStore.open(restore);

/** The open-capture event from the native side; a malformed payload still opens. */
export function onOpenCaptureEvent(payload: unknown) {
  captureStore.open(OpenCapturePayload.parse(payload).restore);
}

export function useCaptureState() {
  return useSyncExternalStore(captureStore.subscribe, captureStore.get);
}

/** "CommandOrControl+Shift+Space" as the keys read on this platform. */
export function displayShortcut(accelerator: string, mac: boolean) {
  return accelerator
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      if (/^(Command|Cmd)Or(Control|Ctrl)$/i.test(k)) return mac ? "Cmd" : "Ctrl";
      if (/^(Control|Ctrl)$/i.test(k)) return "Ctrl";
      if (/^(Command|Cmd|Super|Meta)$/i.test(k)) return mac ? "Cmd" : "Super";
      if (/^(Alt|Option)$/i.test(k)) return mac ? "Option" : "Alt";
      return k;
    })
    .join("+");
}

export type CaptureInput = Omit<TriageInput, "onProgress">;

export type CaptureDeps = {
  triage: (input: CaptureInput) => Promise<TriageResult>;
  /** Puts the window back the way capture found it. */
  restoreWindow: (restore: Restore) => Promise<void>;
  /** Whether the user can see the window (not hidden, not minimised). */
  windowHidden: () => Promise<boolean>;
  notify: (title: string, body: string) => Promise<unknown>;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Toast and notification text for a finished capture. */
export function describeCapture(r: TriageResult) {
  const parts = [
    r.proposals ? `${plural(r.proposals, "proposal")} to approve` : null,
    r.questions ? `${plural(r.questions, "question")} to answer` : null,
  ].filter(Boolean);
  return parts.length
    ? `Captured: ${parts.join(" and ")}`
    : "Captured: nothing to do in that input";
}

const quietly = <A>(p: Promise<A>, fallback: A) => p.catch(() => fallback);

/**
 * Files the input as a new Inbox thread and triages it in the background (FR-11.1).
 * The window goes back to where capture found it straight away; when triage ends
 * with something to decide while the window is out of sight, one notification
 * says so (FR-11.4).
 */
export async function submitCapture(
  input: CaptureInput,
  restore: Restore,
  deps: CaptureDeps,
): Promise<TriageResult> {
  const triage = deps.triage(input);
  await quietly(deps.restoreWindow(restore), undefined);
  let result: TriageResult;
  try {
    result = await triage;
  } catch (e) {
    if (await quietly(deps.windowHidden(), false))
      await quietly(
        deps.notify("Capture not triaged", "It is in the Inbox; open it there to retry."),
        undefined,
      );
    throw e;
  }
  if (result.proposals + result.questions > 0 && (await quietly(deps.windowHidden(), false)))
    await quietly(deps.notify("Secretary", describeCapture(result)), undefined);
  return result;
}

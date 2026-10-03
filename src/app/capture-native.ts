/** Connects quick capture to the desktop: window, tray, global shortcut, `--capture` (D48). */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { logger } from "@/lib/log";
import { captureStore, OPEN_CAPTURE_EVENT, onOpenCaptureEvent, type Restore } from "./capture";
import { useSettings } from "./hooks";
import { sendOsNotification } from "./notify";
import { inTauri } from "./platform";

type CaptureStatus = {
  tray: boolean;
  trayError: string | null;
  wayland: boolean;
  launchCapture: boolean;
};

export async function restoreWindow(restore: Restore) {
  if (!inTauri || !restore) return;
  const win = getCurrentWindow();
  await (restore === "hide" ? win.hide() : win.minimize());
}

export async function windowHidden() {
  if (!inTauri) return false;
  const win = getCurrentWindow();
  return !(await win.isVisible()) || (await win.isMinimized());
}

export const notify = (title: string, body: string) =>
  inTauri ? sendOsNotification(title, body) : Promise.resolve(false);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Listens for the open-capture event, opens capture after a launch with
 * `--capture`, and hands the Capture settings to the native side.
 */
export function useCaptureBridge() {
  const { data: settings } = useSettings();
  const shortcut = settings?.capture.shortcut;
  const closeToTray = settings?.capture.closeToTray;

  useEffect(() => {
    if (!inTauri) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen(OPEN_CAPTURE_EVENT, (e) => onOpenCaptureEvent(e.payload)).then((un) => {
      if (cancelled) un();
      else stop = un;
    });
    void invoke<CaptureStatus>("capture_status")
      .then((s) => {
        captureStore.setNative({ tray: s.tray, trayError: s.trayError, wayland: s.wayland });
        if (s.launchCapture) captureStore.open(null);
      })
      .catch((e) => logger.warn("Capture status failed", e));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!inTauri || closeToTray === undefined) return;
    void invoke("set_close_to_tray", { enabled: closeToTray }).catch((e) =>
      logger.warn("Close to tray setting failed", e),
    );
  }, [closeToTray]);

  useEffect(() => {
    if (!inTauri || shortcut === undefined) return;
    void invoke("set_capture_shortcut", { shortcut })
      .then(() => captureStore.setShortcut({ registered: shortcut || null, error: null }))
      .catch((e) => {
        logger.warn("Capture shortcut not registered", e);
        captureStore.setShortcut({ registered: null, error: message(e) });
      });
  }, [shortcut]);
}

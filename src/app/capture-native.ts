/** Connects quick capture to the desktop: window, tray, global shortcut, `--capture` (D48). */

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Effect } from "effect";
import { useEffect } from "react";
import { logger } from "@/lib/log";
import { Settings } from "@/services/settings";
import {
  captureStore,
  HIDDEN_TO_TRAY_EVENT,
  OPEN_CAPTURE_EVENT,
  onHiddenToTray,
  onOpenCaptureEvent,
  type Restore,
} from "./capture";
import { useSettings } from "./hooks";
import { sendOsNotification } from "./notify";
import { inTauri } from "./platform";
import { queryKeys } from "./query-client";
import { run } from "./runtime";

type CaptureStatus = {
  tray: boolean;
  trayError: string | null;
  wayland: boolean;
  launchCapture: boolean;
};

/**
 * Puts the window back the way capture found it. The native side knows how per
 * platform: on macOS "hide" hides the app, since a hidden window keeps the keyboard.
 */
export async function restoreWindow(restore: Restore) {
  if (!inTauri || !restore) return;
  await invoke("capture_restore", { restore });
}

/** Whether the window is out of sight (hidden, the app hidden on macOS, or minimised). */
export async function windowHidden() {
  if (!inTauri) return false;
  return invoke<boolean>("capture_window_hidden");
}

export const notify = (title: string, body: string) =>
  inTauri ? sendOsNotification(title, body) : Promise.resolve(false);

/** The once-ever "still running in the tray" notice, kept in settings (D48). */
const trayNotice = (client: QueryClient) =>
  onHiddenToTray({
    shown: () => run(Effect.flatMap(Settings, (s) => s.get)).then((s) => s.capture.trayNoticeShown),
    markShown: () =>
      run(
        Effect.flatMap(Settings, (s) =>
          s.update((v) => ({ ...v, capture: { ...v.capture, trayNoticeShown: true } })),
        ),
      ).then((next) => void client.setQueryData(queryKeys.settings, next)),
    notify,
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Listens for the open-capture event, opens capture after a launch with
 * `--capture`, and hands the Capture settings to the native side.
 */
export function useCaptureBridge() {
  const client = useQueryClient();
  const { data: settings } = useSettings();
  const shortcut = settings?.capture.shortcut;
  const closeToTray = settings?.capture.closeToTray;

  useEffect(() => {
    if (!inTauri) return;
    const stops: (() => void)[] = [];
    let cancelled = false;
    const keep = (un: () => void) => {
      if (cancelled) un();
      else stops.push(un);
    };
    void listen(OPEN_CAPTURE_EVENT, (e) => onOpenCaptureEvent(e.payload)).then(keep);
    void listen(HIDDEN_TO_TRAY_EVENT, () =>
      trayNotice(client).catch((e) => logger.warn("Tray notice failed", e)),
    ).then(keep);
    void invoke<CaptureStatus>("capture_status")
      .then((s) => {
        captureStore.setNative({ tray: s.tray, trayError: s.trayError, wayland: s.wayland });
        if (s.launchCapture) captureStore.open(null);
      })
      .catch((e) => logger.warn("Capture status failed", e));
    return () => {
      cancelled = true;
      for (const un of stops) un();
    };
  }, [client]);

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

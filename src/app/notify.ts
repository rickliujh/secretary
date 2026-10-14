/** OS notifications, asking for permission the first time. */
import { toast } from "sonner";
import { isMac } from "./platform";

/**
 * Whether OS notifications are safe to send here (design.md D53). In a dev build
 * on macOS the notification plugin makes the whole process report Terminal's
 * bundle identifier, and from then on macOS 26 stops treating the window as this
 * app's: the Dock icon goes and the window cannot take the keyboard.
 */
export const osNotificationsUsable = (mac: boolean, dev: boolean) => !(mac && dev);

/**
 * Sends one notification; false when it was not sent (not allowed, or a macOS dev
 * build, which shows a toast instead and leaves the caller to retry later).
 */
export async function sendOsNotification(title: string, body: string): Promise<boolean> {
  if (!osNotificationsUsable(isMac, import.meta.env.DEV)) {
    toast.info(title, { description: `${body}\n(Dev build on macOS: no OS notification.)` });
    return false;
  }
  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    "@tauri-apps/plugin-notification"
  );
  const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (!granted) return false;
  sendNotification({ title, body });
  return true;
}

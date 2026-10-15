/** OS notifications, asking for permission the first time. */

/** Sends one notification; false when the user has not allowed them. */
export async function sendOsNotification(title: string, body: string): Promise<boolean> {
  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    "@tauri-apps/plugin-notification"
  );
  const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (!granted) return false;
  sendNotification({ title, body });
  return true;
}

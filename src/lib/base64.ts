/**
 * Bytes to base64 and back, for the bytes of an image crossing the Tauri
 * bridge (D70): a JSON number array would be about four times larger.
 */

/** Base64 of `bytes`, built in chunks so a large image does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** The bytes of a base64 string. Throws on text that is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

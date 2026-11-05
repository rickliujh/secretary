/**
 * sha-256 of bytes as lowercase hex, through Web Crypto (the webview and Bun
 * both have it). Keys a note image's transcript by the file's content (D71).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

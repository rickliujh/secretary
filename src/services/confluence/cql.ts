/** Pure CQL helpers (design.md section 6). */
import { trimBaseUrl } from "@/lib/url";

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Free text searches page titles and bodies. `text ~` is used rather than
 * `siteSearch ~`, which older Data Center versions do not support.
 */
export function textToCql(text: string, spaceKey?: string): string | null {
  const q = text.trim();
  if (!q) return null;
  const space = spaceKey?.trim() ? ` AND space = ${quote(spaceKey.trim())}` : "";
  return `type = page${space} AND (title ~ ${quote(q)} OR text ~ ${quote(q)})`;
}

/** Absolute browser URL for a content item from its `_links`. */
export function webUrl(
  links: { webui?: string; base?: string },
  fallbackBase: string,
): string | null {
  if (!links.webui) return null;
  if (/^https?:/.test(links.webui)) return links.webui;
  return `${trimBaseUrl(links.base || fallbackBase)}${links.webui}`;
}

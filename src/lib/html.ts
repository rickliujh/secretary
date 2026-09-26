/**
 * Sanitises Jira's server-rendered HTML for display (design.md D14).
 * Relative links become absolute; images become links because they need the
 * user's Jira session and are blocked by the CSP anyway.
 */
import DOMPurify from "dompurify";
import { trimBaseUrl } from "./url";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function sanitizeJiraHtml(html: string, baseUrl: string, win: Window = window): string {
  const purify = DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]);
  // DOMPurify returns its input unchanged when the DOM lacks what it needs;
  // never pass unsanitised HTML through, show it as text instead.
  if (!purify.isSupported) return `<pre>${escapeHtml(html)}</pre>`;
  const base = trimBaseUrl(baseUrl);
  const absolute = (href: string) => (href.startsWith("/") ? `${base}${href}` : href);
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href) node.setAttribute("href", absolute(href));
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purify.addHook("uponSanitizeElement", (node, data) => {
    // Duck-typed: `Element` belongs to `win`, which may not be the global window.
    if (data.tagName !== "img" || !("getAttribute" in node) || !node.ownerDocument) return;
    const img = node as Element;
    const link = img.ownerDocument.createElement("a");
    link.setAttribute("href", absolute(img.getAttribute("src") ?? ""));
    const alt = img.getAttribute("alt");
    link.textContent = `[image${alt ? `: ${alt}` : ""}]`;
    img.replaceWith(link);
  });
  return purify.sanitize(html, {
    FORBID_TAGS: ["style", "script", "iframe", "form", "input", "button"],
    FORBID_ATTR: ["style", "onerror", "onclick"],
  });
}

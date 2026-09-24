import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import { sanitizeJiraHtml } from "@/lib/html";
import { cn } from "@/lib/utils";

/** Jira's server-rendered HTML, sanitised; links open in the system browser. */
export function JiraHtml({
  html,
  baseUrl,
  className,
}: {
  html: string;
  baseUrl: string;
  className?: string;
}) {
  const safe = useMemo(() => sanitizeJiraHtml(html, baseUrl), [html, baseUrl]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates clicks on the anchors inside, which are focusable themselves.
    // biome-ignore lint/a11y/noStaticElementInteractions: same as above.
    <div
      className={cn("rich-content text-sm", className)}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        void openUrl(href);
      }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by DOMPurify in sanitizeJiraHtml.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

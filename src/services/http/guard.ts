/**
 * Outbound request guard (design.md D27): only configured hosts, and a clear
 * failure straight away when the OS reports no network.
 */
import { parseUrl } from "@/lib/url";

export const OFFLINE_MESSAGE =
  "No network connection. Cached data is still available; try again when you are back online.";

const hostOf = (url: string | null | undefined) => parseUrl(url)?.host.toLowerCase() ?? null;

/** Hosts typed into a settings form and tested before saving. */
const pending = new Set<string>();

export function allowHost(url: string | null | undefined): void {
  const host = hostOf(url);
  if (host) pending.add(host);
}

export type GuardConfig = {
  jiraBaseUrl: string | null | undefined;
  confluenceBaseUrl: string | null | undefined;
  providerBaseUrls: readonly string[];
};

/** Null when the request may go out, otherwise why not. */
export function checkRequest(url: string, config: GuardConfig, online: boolean): string | null {
  if (!online) return OFFLINE_MESSAGE;
  const host = hostOf(url);
  if (!host) return `Refused a request to an invalid address: ${url.slice(0, 80)}`;
  const allowed = new Set(
    [config.jiraBaseUrl, config.confluenceBaseUrl, ...config.providerBaseUrls]
      .map(hostOf)
      .filter((h): h is string => !!h),
  );
  if (allowed.has(host) || pending.has(host)) return null;
  return `Refused a request to ${host}: it is not your Jira, Confluence or a configured model provider.`;
}

/** Test hook. */
export const clearPendingHosts = () => pending.clear();

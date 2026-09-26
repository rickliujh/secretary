/**
 * Cloud vs Data Center (design.md D19): detection, API base URLs and auth.
 */
import { trimBaseUrl } from "@/lib/url";
import type { DeploymentSetting } from "@/services/settings/schema";

export type Deployment = "cloud" | "datacenter";

export type AtlassianAuth =
  | { type: "bearer"; token: string }
  | { type: "basic"; email: string; token: string };

const CLOUD_HOST = /\.(atlassian\.net|jira\.com|jira-dev\.com)$/i;

export function resolveDeployment(
  baseUrl: string,
  setting: DeploymentSetting = "auto",
): Deployment {
  if (setting !== "auto") return setting;
  try {
    return CLOUD_HOST.test(new URL(baseUrl).hostname) ? "cloud" : "datacenter";
  } catch {
    return "datacenter";
  }
}

/**
 * Jira's REST root. On Cloud the API lives at the site root, so a pasted UI
 * address such as https://site.atlassian.net/jira/... is reduced to the origin.
 * Data Center keeps any context path (https://host/jira).
 */
export function jiraApiBase(baseUrl: string, deployment: Deployment): string {
  return deployment === "cloud" ? new URL(baseUrl).origin : trimBaseUrl(baseUrl);
}

/** Confluence's REST root: `/wiki` on Cloud, the configured context path on Data Center. */
export function confluenceApiBase(baseUrl: string, deployment: Deployment): string {
  return deployment === "cloud" ? `${new URL(baseUrl).origin}/wiki` : trimBaseUrl(baseUrl);
}

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export function authorizationHeader(auth: AtlassianAuth): string {
  return auth.type === "bearer"
    ? `Bearer ${auth.token}`
    : `Basic ${base64(`${auth.email}:${auth.token}`)}`;
}

/** Where to create the token, for settings copy and error messages. */
export const TOKEN_HELP: Record<Deployment, string> = {
  cloud:
    "an API token from id.atlassian.com > Security > API tokens, with your Atlassian account email",
  datacenter: "a personal access token (Profile > Personal Access Tokens)",
};

/**
 * Maps typed service errors to toasts with a retry or a settings link
 * (design.md section 10). Messages are redacted before display.
 */
import { toast } from "sonner";
import { redact } from "@/lib/redact";
import type { SettingsTab } from "./settings-tabs";

type Described = { title: string; description?: string; settingsTab?: SettingsTab };

type Tagged = { _tag: string; message?: string; kind?: string };

const isTagged = (e: unknown): e is Tagged =>
  typeof e === "object" && e !== null && "_tag" in e && typeof (e as Tagged)._tag === "string";

/** A sync asked for while one is already running; the running one reports. */
export const isSyncBusy = (error: unknown) =>
  isTagged(error) && error._tag === "SyncError" && error.kind === "busy";

/** Validation issues carried by a failed model call, redacted. */
export function errorIssues(error: unknown): string[] {
  const issues = isTagged(error) ? (error as { issues?: unknown }).issues : undefined;
  return Array.isArray(issues) ? issues.map((i) => redact(String(i))) : [];
}

export function describeError(error: unknown): Described {
  if (!isTagged(error)) {
    return {
      title: "Something went wrong",
      description: redact(error instanceof Error ? error.message : String(error)),
    };
  }
  const description = error.message ? redact(error.message) : undefined;
  switch (error._tag) {
    case "LlmError":
      if (error.kind === "config" || error.kind === "auth")
        return { title: "Model not available", description, settingsTab: "models" };
      if (error.kind === "refusal") return { title: "The model declined", description };
      if (error.kind === "rate_limit") return { title: "Rate limited", description };
      if (error.kind === "timeout") return { title: "The model timed out", description };
      if (error.kind === "network")
        return { title: "Can't reach the model provider", description, settingsTab: "general" };
      if (error.kind === "schema")
        return { title: "The model's answer was not usable", description };
      return { title: "Model request failed", description };
    case "JiraError":
      if (error.kind === "network")
        return { title: "Can't reach Jira", description, settingsTab: "general" };
      return {
        title: "Jira request failed",
        description,
        settingsTab: error.kind === "not_configured" || error.kind === "auth" ? "jira" : undefined,
      };
    case "ConfluenceError":
      return {
        title: "Confluence request failed",
        description,
        settingsTab:
          error.kind === "not_configured" || error.kind === "auth" ? "confluence" : undefined,
      };
    case "SettingsError":
      return { title: "Settings problem", description, settingsTab: "general" };
    case "ExecutorError":
      return { title: "That action cannot run", description };
    case "ProposalError":
      return { title: "Proposal not available", description };
    case "IntakeError":
      return {
        title: error.kind === "empty" ? "Nothing to read" : "Thread not found",
        description,
      };
    case "SyncError":
      return error.kind === "busy"
        ? { title: "A sync is already running", description }
        : { title: "Sync scope problem", description, settingsTab: "jira" };
    case "TransferError":
      return { title: "Import refused", description };
    case "LearningError":
      return { title: "Not enough to learn from", description };
    case "CommsError":
      return { title: "Draft not available", description };
    case "SecretsError":
      return { title: "Keychain problem", description };
    case "DbError":
      return { title: "Database error", description, settingsTab: "data" };
    default:
      return { title: "Something went wrong", description };
  }
}

export function toastError(
  error: unknown,
  opts: { retry?: () => void; openSettings?: (tab: SettingsTab) => void } = {},
) {
  const d = describeError(error);
  const { settingsTab } = d;
  const action =
    settingsTab && opts.openSettings
      ? { label: "Open settings", onClick: () => opts.openSettings?.(settingsTab) }
      : opts.retry
        ? { label: "Retry", onClick: opts.retry }
        : undefined;
  toast.error(d.title, { description: d.description, action });
}

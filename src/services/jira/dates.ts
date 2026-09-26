/**
 * Jira timestamps look like `2026-09-21T16:40:12.000+0100`. The offset has
 * no colon, which WebKit's Date parser rejects, so normalise before parsing.
 */
export function jiraDateToIso(value: string): string {
  const fixed = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(fixed);
  if (Number.isNaN(d.getTime())) throw new Error(`Unrecognised Jira date: ${value}`);
  return d.toISOString();
}

export const jiraDateToIsoOrNull = (value: unknown): string | null =>
  typeof value === "string" && value ? jiraDateToIso(value) : null;

/**
 * Formats an instant as a JQL date literal (`yyyy/MM/dd HH:mm`) in the Jira
 * user's time zone, which is how Jira interprets JQL dates.
 */
export function toJqlDate(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * Deterministic intake preprocessing (design.md 7.3 step 1). No model calls.
 */

export type Contact = {
  id: string;
  displayName: string;
  email: string | null;
  jiraUsername: string | null;
};

export type References = {
  issueKeys: string[];
  /** ServiceNow numbers such as INC0012345. */
  tickets: string[];
  emails: string[];
  urls: string[];
  /** Contact ids mentioned by name, email, @username or Jira username. */
  contactIds: string[];
};

const ISSUE_KEY = /\b([A-Z][A-Z0-9_]{1,9}-\d{1,7})\b/g;
const SNOW = /\b((?:INC|RITM|REQ|CHG|PRB|SCTASK)\d{7,})\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const URL = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const BROWSE_URL = /\/browse\/([A-Z][A-Z0-9_]{1,9}-\d{1,7})\b/g;

/** Keys that look like issue keys but are not (ServiceNow, encodings, standards). */
const NOT_ISSUE_PREFIX = /^(UTF|ISO|SHA|MD|RFC|TLS|SSL|HTTP|COVID|INC|RITM|REQ|CHG|PRB|SCTASK)$/;

const unique = <T>(xs: T[]) => [...new Set(xs)];

// Markers that start quoted history in replies and forwards.
const HISTORY_MARKERS = [
  /^On .{3,120} wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^From: .+\r?\n(?:Sent|Date): .+$/m,
  /^_{10,}\s*$/m,
  /^Begin forwarded message:/m,
];

const SIGN_OFF =
  /^(?:kind regards|best regards|regards|best|many thanks|thanks|thank you|cheers|br)[,.!]?\s*$/i;
const SIGNATURE_DELIMITER = /^-- ?$/m;

/** Removes quoted history, `>` quoted lines and trailing signatures; normalises whitespace. */
export function cleanInput(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  let cut = text.length;
  for (const marker of HISTORY_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  const sig = SIGNATURE_DELIMITER.exec(text);
  if (sig && sig.index > 0 && sig.index < cut) cut = sig.index;
  text = text.slice(0, cut);

  let lines = text.split("\n").filter((l) => !/^\s*>/.test(l));
  // A sign-off followed by at most four short lines (name, title, phone) ends the message.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const line = lines[i] ?? "";
    if (SIGN_OFF.test(line.trim()) && lines.slice(i + 1).every((l) => l.trim().length < 60)) {
      lines = lines.slice(0, i);
      break;
    }
  }
  return lines
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractReferences(text: string, contacts: readonly Contact[] = []): References {
  const keys = [
    ...[...text.matchAll(ISSUE_KEY)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(BROWSE_URL)].map((m) => m[1] ?? ""),
  ].filter((k) => !NOT_ISSUE_PREFIX.test(k.split("-")[0] ?? ""));
  const emails = unique([...text.matchAll(EMAIL)].map((m) => m[0].toLowerCase()));
  const lower = text.toLowerCase();

  const contactIds: string[] = [];
  const firstNames = new Map<string, Contact[]>();
  for (const c of contacts) {
    const first = c.displayName.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first.length >= 3) firstNames.set(first, [...(firstNames.get(first) ?? []), c]);
  }
  for (const c of contacts) {
    const name = new RegExp(
      `(^|[^\\p{L}])${escapeRegExp(c.displayName.toLowerCase())}($|[^\\p{L}])`,
      "u",
    );
    const byName = name.test(lower);
    const byEmail = !!c.email && emails.includes(c.email.toLowerCase());
    const user = c.jiraUsername?.toLowerCase();
    // Sentence punctuation may follow a username ("ping tom.k."), but not more username characters.
    const byUser =
      !!user && new RegExp(`(^|[\\s(@])@?${escapeRegExp(user)}(?![\\w-])(?!\\.\\w)`).test(lower);
    // A first name counts only when exactly one contact has it.
    const first = c.displayName.split(/\s+/)[0]?.toLowerCase() ?? "";
    const byFirst =
      first.length >= 3 &&
      firstNames.get(first)?.length === 1 &&
      new RegExp(`(^|[^\\p{L}])@?${escapeRegExp(first)}($|[^\\p{L}])`, "u").test(lower);
    if (byName || byEmail || byUser || byFirst) contactIds.push(c.id);
  }

  return {
    issueKeys: unique(keys),
    tickets: unique([...text.matchAll(SNOW)].map((m) => m[1] ?? "")),
    emails,
    urls: unique([...text.matchAll(URL)].map((m) => m[0].replace(/[.,;:]+$/, ""))),
    contactIds: unique(contactIds),
  };
}

/** Short inputs are one item; longer ones go through `segment_input`. */
export function needsSegmentation(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim()).length;
  return text.length > 700 || lines > 10;
}

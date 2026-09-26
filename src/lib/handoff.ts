/**
 * Links that hand a draft to the user's own Teams or mail app (D31). No sign-in and
 * no Microsoft Graph: the link opens a chat or a compose window with the text filled
 * in, and the user presses Send there (D8).
 */

/**
 * Longest `mailto:` link we hand over. Windows passes URLs to the default mail app
 * through a path that truncates around 2048 characters, and some mail apps cut
 * links shorter than that, so stay under it.
 */
export const MAILTO_MAX_LENGTH = 2000;

/**
 * Longest Teams deep link we hand over. The link goes through the browser or the
 * desktop app's protocol handler; long ones get cut or rejected, so keep a margin.
 */
export const TEAMS_MAX_LENGTH = 4000;

const TEAMS_CHAT = "https://teams.microsoft.com/l/chat/0/0";

/** The address list with each address encoded but `@` kept readable. */
const addressList = (emails: string[]) => {
  const list = emails.map((e) => e.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("A handoff link needs at least one email address");
  return list.map((e) => encodeURIComponent(e).replaceAll("%40", "@")).join(",");
};

/** `a=b&c=d` from the non-empty values, each encoded with `%20` for spaces. */
const queryString = (params: [string, string | null | undefined][]) =>
  params
    .filter((p): p is [string, string] => !!p[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

const withQuery = (base: string, query: string) => (query ? `${base}?${query}` : base);

/**
 * A Teams link that opens a chat with these people and the message in the compose
 * box. More than one address opens a group chat.
 */
export const teamsChatUrl = (emails: string[], message: string): string => {
  const text = queryString([["message", message.replace(/\r\n?/g, "\n")]]);
  return `${TEAMS_CHAT}?users=${addressList(emails)}${text ? `&${text}` : ""}`;
};

/** Line breaks as CRLF, which mail clients expect in a `mailto:` body (RFC 6068). */
const crlf = (s: string) => s.replace(/\r\n|\r|\n/g, "\r\n");

/** A `mailto:` link that opens the default mail app with a new message filled in. */
export const mailtoUrl = ({
  to,
  subject,
  body,
}: {
  to: string[];
  subject?: string | null;
  body: string;
}): string =>
  withQuery(
    `mailto:${addressList(to)}`,
    queryString([
      ["subject", subject?.trim()],
      ["body", crlf(body)],
    ]),
  );

/** Whether a handoff link is short enough to pass on intact. */
export const handoffFits = (url: string): boolean =>
  url.length <= (url.startsWith("mailto:") ? MAILTO_MAX_LENGTH : TEAMS_MAX_LENGTH);

export type HandoffChannel = "teams" | "email";

export type Handoff = {
  url: string;
  /** False when the text was too long for a link and must go via the clipboard. */
  bodyIncluded: boolean;
};

/**
 * The link for a draft. When the text makes it too long, the link opens the chat or
 * compose window without it (keeping an email's subject when that still fits).
 * Teams ignores the subject.
 */
export const handoffLink = (
  channel: HandoffChannel,
  { to, subject, body }: { to: string[]; subject?: string | null; body: string },
): Handoff => {
  const build = (text: string, subj: string | null | undefined) =>
    channel === "teams" ? teamsChatUrl(to, text) : mailtoUrl({ to, subject: subj, body: text });
  const full = build(body, subject);
  if (handoffFits(full)) return { url: full, bodyIncluded: true };
  const withoutBody = build("", subject);
  return {
    url: handoffFits(withoutBody) ? withoutBody : build("", null),
    bodyIncluded: false,
  };
};

/** Why a draft cannot be handed off: a team, a person without an email, or no one. */
export type HandoffBlock = "team" | "no-email" | "no-recipient";

/**
 * The addresses to hand a draft to, or why there are none. Teams chats and emails
 * need a person's email from the People directory; a team has none.
 */
export const handoffRecipients = ({
  person,
  team,
}: {
  person: { email: string | null } | null;
  team: unknown;
}): { to: string[] } | { blocked: HandoffBlock } => {
  if (person) {
    const email = person.email?.trim();
    return email ? { to: [email] } : { blocked: "no-email" };
  }
  return { blocked: team ? "team" : "no-recipient" };
};

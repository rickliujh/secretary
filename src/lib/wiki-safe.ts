/**
 * Proposal text bound for Jira, made safe after conversion to wiki markup (D51).
 * The model may copy markup from pasted text, and the approval card shows
 * Markdown where it is easy to miss, so:
 * - a remote image embed (`!https://x/p.png!`, `!https://x/p.png|width=1!`, also
 *   what `![](https://x/p.png)` converts to) becomes a plain link, so nobody who
 *   opens the ticket loads it;
 * - a mention (`[~username]` on Data Center, `[~accountid:ID]` on Cloud, or the
 *   aliased `[name|~username]`) stays only when it names a known Jira user, and
 *   otherwise is escaped so it shows as text and notifies no one.
 * Image names without a scheme (`!screenshot.png!`) refer to the issue's own
 * attachments, so they load nothing from outside and are left alone. `{code}` and
 * `{noformat}` blocks render literally in Jira and are left alone too.
 */

export type WikiSafety = {
  wiki: string;
  /** Remote image URLs written as links. */
  images: string[];
  /** Mentions written as text, by the user id they named. */
  mentions: string[];
};

const LITERAL_BLOCK = /\{(code|noformat)(?::[^}\n]*)?\}[\s\S]*?\{\1\}/g;
/** `!` then a scheme (`https:`, `data:`, ...) or `//`, up to the closing `!` on the same line. */
const REMOTE_IMAGE = /(?<!\\)!((?:[a-z][a-z0-9+.-]*:|\/\/)[^!\n]*)!/gi;
/** `[~id]` or `[alias|~id]`; Cloud ids are `accountid:...`. */
const MENTION = /(?<!\\)\[(?:[^\][|\n]*\|)?~([^\]|\n]+)\]/g;

/** A user id as compared: Cloud's `accountid:` prefix dropped, case ignored. */
export const mentionId = (id: string) =>
  id
    .trim()
    .replace(/^accountid:/i, "")
    .toLowerCase();

/** The URL of an image embed's body (`url|width=1`, `url "title"`), safe inside `[...]`. */
const imageUrl = (body: string) =>
  (body.split(/[|\s]/)[0] ?? body).replace(/\[/g, "%5B").replace(/\]/g, "%5D");

function sanitiseSegment(text: string, known: ReadonlySet<string>, out: WikiSafety): string {
  return text
    .replace(REMOTE_IMAGE, (_m, body: string) => {
      const url = imageUrl(body);
      out.images.push(url);
      return `[${url}]`;
    })
    .replace(MENTION, (m, id: string) => {
      if (known.has(mentionId(id))) return m;
      out.mentions.push(id.trim());
      // A backslash makes Jira show the bracket as text, so no link and no notification.
      return `\\${m}`;
    });
}

/**
 * Proposal wiki markup with remote images as links and mentions of users not in
 * `knownUsers` as text. `knownUsers` are Jira user ids: usernames on Data Center,
 * account ids on Cloud (with or without the `accountid:` prefix).
 */
export function sanitiseProposalWiki(
  wiki: string,
  knownUsers: Iterable<string | null | undefined>,
): WikiSafety {
  const known = new Set<string>();
  for (const u of knownUsers) if (u?.trim()) known.add(mentionId(u));
  const out: WikiSafety = { wiki: "", images: [], mentions: [] };
  let rest = 0;
  const parts: string[] = [];
  for (const m of wiki.matchAll(LITERAL_BLOCK)) {
    parts.push(sanitiseSegment(wiki.slice(rest, m.index), known, out), m[0]);
    rest = m.index + m[0].length;
  }
  parts.push(sanitiseSegment(wiki.slice(rest), known, out));
  out.wiki = parts.join("");
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What the sanitiser changed, for a `ProposalResult.warning`, or null when
 * nothing was: "In the comment, 1 remote image became a link and the mention of
 * jsmith became plain text (not a Jira user Secretary knows)."
 */
export function wikiSafetyWarning(
  s: Pick<WikiSafety, "images" | "mentions">,
  where: string,
): string | null {
  const parts: string[] = [];
  const n = s.images.length;
  if (n)
    parts.push(
      `${n} remote ${plural(n, "image", "images")} ${plural(n, "became a link", "became links")}`,
    );
  const ids = [...new Set(s.mentions)];
  if (ids.length)
    parts.push(
      `the ${plural(ids.length, "mention", "mentions")} of ${ids.join(", ")} became plain text (not a Jira user Secretary knows)`,
    );
  if (!parts.length) return null;
  return `In the ${where}, ${parts.join(" and ")}.`;
}

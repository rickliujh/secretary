/**
 * Proposal text bound for Jira, made safe after conversion to wiki markup (D51).
 * The model may copy markup from pasted text, and the approval card shows
 * Markdown where it is easy to miss, so:
 * - a remote image embed (`!https://x/p.png!`, `!https://x/p.png|width=1!`, also
 *   what `![](https://x/p.png)` converts to) becomes a plain link, and any other
 *   `!...!` span that names a URL, in whatever wrapping, loses its opening `!`, so
 *   nobody who opens the ticket loads it;
 * - a mention (`[~username]` on Data Center, `[~accountid:ID]` on Cloud, or a link
 *   such as `[name|~username|tip]` whose target starts with `~`) stays only when it
 *   names a known Jira user, and otherwise is escaped so it shows as text and
 *   notifies no one.
 * Image names without a scheme (`!screenshot.png!`) refer to the issue's own
 * attachments, so they load nothing from outside and are left alone. Balanced
 * `{code}` and `{noformat}` blocks render literally in Jira and are left alone too.
 *
 * Jira's renderer cannot be run here, so wherever its reading is uncertain the
 * output is made unambiguous instead of guessed at:
 * - A run of backslashes escapes the next character only when its length is odd
 *   (`\\` is a line break).
 * - A literal block is a lowercase, unescaped `{code}` / `{noformat}` opener (with
 *   optional `:params`) and the first `{code}` / `{noformat}` closer of the same
 *   name after it. Any other block-macro token, in any case, escaped or not,
 *   unbalanced, or inside a block, is broken up (`{ code}`), so the text has no
 *   block marker except those of balanced blocks and Jira cannot pair them any
 *   other way.
 * - Any unescaped `!` could open an image whatever came before it, so each one is
 *   checked against the text up to the next unescaped `!` on its line (literal
 *   block text in between counts, its `!`s do not end the span).
 * - Any unescaped `[` could open a link, so each one is checked against the text up
 *   to the next unescaped `]` on its line; a part (split on `|`) starting with `~`
 *   makes it a mention.
 */

export type WikiSafety = {
  wiki: string;
  /** Remote image URLs written as links (or otherwise kept from loading). */
  images: string[];
  /** Mentions written as text, by the user id they named. */
  mentions: string[];
};

/** A user id as compared: Cloud's `accountid:` prefix dropped, case ignored. */
export const mentionId = (id: string) =>
  id
    .trim()
    .replace(/^accountid:/i, "")
    .trim()
    .toLowerCase();

/**
 * A block macro's name right after `{`, in any case: `{code`, `{NoFormat`. The
 * one pattern both for finding blocks and for breaking up markers that are not
 * part of a balanced block.
 */
const BLOCK_TOKEN = /\{(code|noformat)(?![\w-])/gi;
/** A block opener as code writes it: lowercase, optional `:params`, at the start. */
const OPENER = /^\{(code|noformat)(?::[^}\n]*)?\}/;

/**
 * Text where no `{code}` / `{noformat}` marker, in any case, opens or closes a
 * block: each is broken up as `{ code}`. Idempotent. Used inside a literal block
 * (D44's quote) so the text cannot end it early.
 */
export const neutraliseBlockMarkers = (text: string) => text.replace(BLOCK_TOKEN, "{ $1");

/** Whether `text[i]` is escaped: an odd run of backslashes right before it. */
function escapedAt(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

type Piece = { text: string; literal: boolean };

/**
 * Pass 1: one walk from the left, splitting the text into live text and balanced
 * literal blocks, and breaking up every other block marker.
 */
function splitLiteralBlocks(text: string): Piece[] {
  const pieces: Piece[] = [];
  let live = "";
  let i = 0;
  const token = new RegExp(BLOCK_TOKEN.source, "gi");
  for (;;) {
    token.lastIndex = i;
    const m = token.exec(text);
    if (!m) break;
    const t = m.index;
    live += text.slice(i, t);
    const opener = OPENER.exec(text.slice(t));
    if (opener && !escapedAt(text, t)) {
      const name = opener[1] ?? "";
      const bodyStart = t + opener[0].length;
      const closerText = `{${name}}`;
      // The first closer not right after a backslash; an escaped-looking one is
      // left inside and broken up, so Jira cannot read it either way.
      let closer = text.indexOf(closerText, bodyStart);
      while (closer >= 0 && text[closer - 1] === "\\")
        closer = text.indexOf(closerText, closer + 1);
      if (closer >= 0) {
        if (live) pieces.push({ text: live, literal: false });
        live = "";
        pieces.push({
          text: opener[0] + neutraliseBlockMarkers(text.slice(bodyStart, closer)) + closerText,
          literal: true,
        });
        i = closer + closerText.length;
        continue;
      }
    }
    // Unbalanced, escaped, or not in code's lowercase form: not a block, ever.
    live += "{ ";
    i = t + 1;
  }
  live += text.slice(i);
  if (live) pieces.push({ text: live, literal: false });
  return pieces;
}

/**
 * Wiki markup whose `{code}` / `{noformat}` markers all belong to balanced
 * blocks: any other marker is broken up. Text that code joins to more text
 * (a small ask's quote block, D44) goes through this first, so a marker it
 * leaves open cannot pair with the next block's opener. Idempotent.
 */
export const balanceBlockMarkers = (wiki: string) =>
  splitLiteralBlocks(wiki)
    .map((p) => p.text)
    .join("");

/** Characters with a flag for "inside a literal block", edited in place. */
type Cells = { ch: string[]; literal: boolean[] };

const toCells = (pieces: readonly Piece[]): Cells => {
  const ch: string[] = [];
  const literal: boolean[] = [];
  for (const p of pieces)
    for (const c of p.text) {
      ch.push(c);
      literal.push(p.literal);
    }
  return { ch, literal };
};

const cellsToPieces = (cells: Cells): Piece[] =>
  cells.ch.map((text, i) => ({ text, literal: cells.literal[i] ?? false }));

/** Whether cell `i` is escaped: the text before it ends in an odd run of backslashes. */
function cellEscaped(ch: readonly string[], i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0; j--) {
    const s = ch[j] ?? "";
    let k = s.length - 1;
    while (k >= 0 && s[k] === "\\") k--;
    n += s.length - 1 - k;
    if (k >= 0) break;
  }
  return n % 2 === 1;
}

/** The next live, unescaped `close` after `from` on the same line, or -1. */
function nextCloser(cells: Cells, from: number, close: string): number {
  const { ch, literal } = cells;
  for (let j = from + 1; j < ch.length; j++) {
    if (literal[j]) continue;
    if (ch[j] === "\n") return -1;
    if (ch[j] === close && !cellEscaped(ch, j)) return j;
  }
  return -1;
}

/** The ids a link's text names as mentions: parts (split on `|`) that start with `~`. */
function mentionedIds(linkText: string): string[] {
  const ids: string[] = [];
  for (const part of linkText.split("|")) {
    const p = part.trim().replace(/^\\+/, "");
    if (p.startsWith("~")) ids.push(p.slice(1).trim());
  }
  return ids;
}

/**
 * Pass 2, from the left: every unescaped `[` that opens a link naming a user
 * who is not known gets a backslash, so Jira shows it as text. Only a `\` before
 * a `[` is added, which changes no other bracket's reading.
 */
function escapeUnknownMentions(cells: Cells, known: ReadonlySet<string>, out: WikiSafety) {
  const { ch, literal } = cells;
  for (let p = 0; p < ch.length; p++) {
    if (literal[p] || ch[p] !== "[" || cellEscaped(ch, p)) continue;
    const q = nextCloser(cells, p, "]");
    if (q < 0) continue;
    const ids = mentionedIds(ch.slice(p + 1, q).join(""));
    const unknown = ids.filter((id) => !known.has(mentionId(id)));
    if (!unknown.length) continue;
    out.mentions.push(...unknown.map((id) => id || "~"));
    ch[p] = "\\[";
  }
}

/**
 * Whether the text between two `!`s could make a browser load something from
 * elsewhere: `//` (a backslash read as a slash, tabs and newlines dropped, as
 * browsers do), or a URL scheme (`https:`, `data:`, any) anywhere in it.
 */
export function namesRemote(body: string): boolean {
  const s = body.replace(/[\t\r\n]/g, "").replace(/\\/g, "/");
  return s.includes("//") || /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:(?=\S)/i.test(s);
}

/**
 * The URL of a plain web image embed (`url`, `url|attributes`, `url "title"`),
 * which is written as a link; null for anything else, which instead loses its `!`.
 */
function plainImageUrl(body: string): string | null {
  const m = /^((?:(?:https?|ftp):)?\/\/[^\s|\\]*)(?:\|.*|\s+"[^"]*"\s*)?$/i.exec(body);
  return m?.[1] ?? null;
}

/** A URL the warning can name, when the body has one that loads from the web. */
const URL_IN = /(?:(?:https?|ftp|data|blob|file):|\/\/)[^\s|!<>"'[\]\\]+/i;

/**
 * Pass 3, from the left, pairing `!`s as an image is read: an unescaped `!` whose
 * span names a remote target becomes a plain link when it is a plain web embed
 * (its closing `!` goes with it), and otherwise gets a backslash so it opens no
 * image.
 */
function defuseRemoteImages(cells: Cells, out: WikiSafety) {
  const { ch, literal } = cells;
  for (let p = 0; p < ch.length; p++) {
    if (literal[p] || ch[p] !== "!" || cellEscaped(ch, p)) continue;
    const q = nextCloser(cells, p, "!");
    if (q < 0) continue;
    const body = ch.slice(p + 1, q).join("");
    if (!namesRemote(body)) continue;
    const url = literal.slice(p + 1, q).some(Boolean) ? null : plainImageUrl(body);
    if (url) {
      out.images.push(url);
      ch[p] = `[${url.replace(/\[/g, "%5B").replace(/\]/g, "%5D")}]`;
      for (let j = p + 1; j <= q; j++) ch[j] = "";
      p = q;
    } else {
      const named = /^\s/.test(body) ? null : URL_IN.exec(body);
      if (named) out.images.push(named[0]);
      ch[p] = "\\!";
    }
  }
}

/**
 * Pass 4, from the right, so each `!` is judged against the final text after it:
 * pass 3 removed or escaped some `!`s, which can stretch the span of a `!` before
 * them (`!!https://x/p.png!!`), so any `!` whose span now names a remote target
 * gets a backslash. Only backslashes are added here, never a link.
 */
function escapeStretchedImages(cells: Cells) {
  const { ch, literal } = cells;
  for (let p = ch.length - 1; p >= 0; p--) {
    if (literal[p] || ch[p] !== "!" || cellEscaped(ch, p)) continue;
    const q = nextCloser(cells, p, "!");
    if (q >= 0 && namesRemote(ch.slice(p + 1, q).join(""))) ch[p] = "\\!";
  }
}

/**
 * Proposal wiki markup with remote images as links and mentions of users not in
 * `knownUsers` as text. `knownUsers` are Jira user ids: usernames on Data Center,
 * account ids on Cloud (with or without the `accountid:` prefix). Idempotent:
 * its output passes through unchanged.
 */
export function sanitiseProposalWiki(
  wiki: string,
  knownUsers: Iterable<string | null | undefined>,
): WikiSafety {
  const known = new Set<string>();
  for (const u of knownUsers) if (u?.trim()) known.add(mentionId(u));
  const out: WikiSafety = { wiki: "", images: [], mentions: [] };
  const mentionCells = toCells(splitLiteralBlocks(wiki));
  escapeUnknownMentions(mentionCells, known, out);
  // Re-split so a `\[` added above is two characters again for the image pass.
  const imageCells = toCells(cellsToPieces(mentionCells));
  defuseRemoteImages(imageCells, out);
  escapeStretchedImages(imageCells);
  out.wiki = imageCells.ch.join("");
  return out;
}

/**
 * Plain text as wiki markup that Jira shows as typed: every markup character
 * gets a backslash. A backslash in the text becomes `⧵` (U+29F5), since `\\`
 * is a line break in wiki markup and a lone one would escape what follows.
 */
export const escapeWikiText = (text: string) =>
  text.replace(/\\/g, "⧵").replace(/[[\]{}!*_~|^+?#-]/g, "\\$&");

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

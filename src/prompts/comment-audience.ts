/**
 * A Jira comment is for the people who read the ticket, about the work (D55
 * answers). A model that cannot set an existing ticket's points tends to say so
 * in a comment ("I cannot estimate existing tickets. Please provide the story
 * points you would like to assign"), which would post a reply to the user where
 * other people read it. This check catches that one pattern so repair asks the
 * model to use its question instead.
 *
 * It is best-effort and English-only; the classify prompt rule is the main
 * defence. It is narrow on purpose: it looks only at bodies about story points
 * or estimates that also say what the writer cannot do, ask the reader for a
 * value, or acknowledge "the request". A request or question addressed to
 * someone by name ("Bob, please provide story points ...") is for a reader, and
 * a phrase the user wrote themselves (typed input, instructions) is theirs to
 * post, so both pass. Comments the user dictates that are not about points pass
 * whatever their wording ("I can't update the schema until ...").
 */

const TOPIC = /\b(?:story\s*points?|points?|(?:re-?)?estimat\w*|pointers?)\b/i;

/** The writer on what it cannot do: "I cannot", "I'm unable", "cannot be estimated". */
const INABILITY: readonly RegExp[] = [
  /\bI(?:\s+(?:cannot|can\s*not|can['’]t|won['’]t|will\s+not|do\s+not|don['’]t|am\s+(?:unable|not\s+able))|['’]m\s+(?:unable|not\s+able))\b/gi,
  /\b(?:cannot|can\s*not|can['’]t)\s+be\s+(?:re-?)?estimated\b/gi,
];

/** A request to the reader for a value: "please provide", "could you", "what value". */
const REQUEST: readonly RegExp[] = [
  /\bplease\s+(?:provide|specify|share|confirm|tell\s+me|let\s+me\s+know)\b/gi,
  /\bkindly\b/gi,
  /\bcould\s+you\b/gi,
  /\b(?:what|which)\s+value\b/gi,
  /\byou(?:\s+would|['’]d)\s+like\b/gi,
  /\byou\s+want\b/gi,
];

/** Acknowledging the request about points instead of acting on it. */
const ACKNOWLEDGE = /\backnowledg\w*\s+(?:the|your|this)\s+request\b/gi;

/** Words that open a sentence with a comma but name nobody. */
const NOT_A_NAME =
  /^(?:please|kindly|however|unfortunately|also|so|otherwise|alternatively|meanwhile|sorry|yes|no|ok|okay|thanks|note|then|now|first|finally|again|still)$/i;

/** The sentence speaks to someone by name or mention: "Bob, ...", "@bob", "[~bob]". */
function addressed(sentence: string): boolean {
  if (/(?:^|\s)@\w|\[~[^\]]+\]/.test(sentence)) return true;
  const m = /^\s*(?:(?:hi|hello|hey)\s+)?([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)\s*,/.exec(sentence);
  return !!m?.[1] && !NOT_A_NAME.test(m[1]);
}

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

/**
 * The wording that talks to the user rather than the ticket's readers, or null.
 * `ownWords` is what the user wrote themselves (typed input, instructions): a
 * phrase found there is theirs.
 */
export function userAddressedPhrase(body: string, ownWords: readonly string[] = []): string | null {
  if (!TOPIC.test(body)) return null;
  const own = norm(ownWords.join("\n"));
  const theirs = (phrase: string) => !!own && own.includes(norm(phrase));
  for (const sentence of body.split(/(?<=[.!?])\s+/)) {
    const toSomeone = addressed(sentence);
    const found: string[] = [];
    for (const re of INABILITY) for (const m of sentence.matchAll(re)) found.push(m[0]);
    for (const m of sentence.matchAll(ACKNOWLEDGE)) found.push(m[0]);
    if (!toSomeone) {
      for (const re of REQUEST) for (const m of sentence.matchAll(re)) found.push(m[0]);
      if (sentence.trim().endsWith("?")) found.push(sentence.trim());
    }
    const phrase = found.find((p) => !theirs(p));
    if (phrase) return phrase;
  }
  return null;
}

/** The repair message for a comment that talks to the user, or null. */
export function commentAudienceProblem(
  body: unknown,
  ownWords: readonly string[] = [],
): string | null {
  if (typeof body !== "string") return null;
  const phrase = userAddressedPhrase(body, ownWords);
  return phrase
    ? `this comment talks to the user ("${phrase}"), but a comment is posted on the ticket for the people who read it, about the work. To tell the user you cannot do something, or to ask them for a value such as the points to set, use question; when nothing should change on the ticket, leave the comment out.`
    : null;
}

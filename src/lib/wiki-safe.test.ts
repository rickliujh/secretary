import { describe, expect, test } from "bun:test";
import { markdownToWiki } from "./wiki";
import { mentionId, sanitiseProposalWiki, wikiSafetyWarning } from "./wiki-safe";

const known = ["ana.b", "5b10ac8d82e05b22cc7d4ef5", null];
const safe = (wiki: string) => sanitiseProposalWiki(wiki, known);
const fromMd = (md: string) => safe(markdownToWiki(md));

describe("sanitiseProposalWiki: images", () => {
  test("a Markdown image becomes a plain link", () => {
    expect(fromMd("See ![](https://x.io/p.png) here")).toEqual({
      wiki: "See [https://x.io/p.png] here",
      images: ["https://x.io/p.png"],
      mentions: [],
    });
  });

  test("a Markdown image with alt text and title keeps only the URL", () => {
    expect(fromMd('![chart](https://x.io/p.png "Q3")').wiki).toBe("[https://x.io/p.png]");
  });

  test("a wiki image embed becomes a plain link", () => {
    expect(safe("!http://x.io/p.png!").wiki).toBe("[http://x.io/p.png]");
  });

  test("an embed with attributes drops them", () => {
    expect(safe("before !https://x.io/p.png|width=1,height=1! after")).toMatchObject({
      wiki: "before [https://x.io/p.png] after",
      images: ["https://x.io/p.png"],
    });
  });

  test("protocol-relative, upper-case and data URLs count as remote", () => {
    const r = safe("!//x.io/a.png! !HTTPS://X.IO/B.PNG! !data:image/png;base64,AAAA!");
    // Only web URLs become links; any other scheme just loses the image's `!`.
    expect(r.wiki).toBe("[//x.io/a.png] [HTTPS://X.IO/B.PNG] \\!data:image/png;base64,AAAA!");
    expect(r.images).toHaveLength(3);
  });

  test("an attachment name (no scheme) is the issue's own file and stays", () => {
    expect(safe("!screenshot.png! and !image-2024.png|thumbnail!")).toEqual({
      wiki: "!screenshot.png! and !image-2024.png|thumbnail!",
      images: [],
      mentions: [],
    });
  });

  test("exclamation marks in prose do not hide a later embed", () => {
    expect(safe("Hello!world and !https://x.io/p.png!").wiki).toBe(
      "Hello!world and [https://x.io/p.png]",
    );
    expect(safe("Great! Thanks!").wiki).toBe("Great! Thanks!");
  });

  test("brackets in the URL cannot break out of the link", () => {
    expect(safe("!https://x.io/a]b.png!").wiki).toBe("[https://x.io/a%5Db.png]");
  });
});

describe("sanitiseProposalWiki: mentions", () => {
  test("a known Data Center username stays a mention", () => {
    expect(safe("Thanks [~ana.b] and [~ANA.B]")).toEqual({
      wiki: "Thanks [~ana.b] and [~ANA.B]",
      images: [],
      mentions: [],
    });
  });

  test("an unknown Data Center username becomes literal text", () => {
    expect(safe("ping [~jsmith] please")).toEqual({
      wiki: "ping \\[~jsmith] please",
      images: [],
      mentions: ["jsmith"],
    });
  });

  test("a known Cloud account id stays, with or without the prefix in the known list", () => {
    expect(safe("[~accountid:5b10ac8d82e05b22cc7d4ef5] ok").mentions).toEqual([]);
    expect(sanitiseProposalWiki("[~accountid:abc123]", ["accountid:abc123"]).mentions).toEqual([]);
  });

  test("an unknown Cloud account id becomes literal text", () => {
    expect(safe("cc [~accountid:557058:f00d]")).toEqual({
      wiki: "cc \\[~accountid:557058:f00d]",
      images: [],
      mentions: ["accountid:557058:f00d"],
    });
  });

  test("an aliased user link counts as a mention", () => {
    expect(safe("[John|~jsmith] and [Ana|~ana.b]").wiki).toBe("\\[John|~jsmith] and [Ana|~ana.b]");
  });

  test("a mention already escaped is left as it is", () => {
    expect(safe("\\[~jsmith]")).toMatchObject({ wiki: "\\[~jsmith]", mentions: [] });
  });

  test("Markdown text carrying a mention is handled after conversion", () => {
    expect(fromMd("**Ask** [~jsmith] about it").wiki).toBe("*Ask* \\[~jsmith] about it");
  });

  test("mention ids compare without the Cloud prefix or case", () => {
    expect(mentionId(" AccountId:ABC ")).toBe("abc");
  });
});

describe("sanitiseProposalWiki: what stays", () => {
  test("ordinary formatting, links, lists, tables and keys are untouched", () => {
    const wiki = markdownToWiki(
      "## Plan\n\n**bold**, *it*, `mono` and [site](https://x.io)\n\n- PAY-2\n- INC0012345\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(safe(wiki)).toEqual({ wiki, images: [], mentions: [] });
  });

  test("code and noformat blocks render literally and are left alone", () => {
    const code = "```\n![](https://x.io/p.png)\n[~jsmith]\n```";
    expect(fromMd(code)).toEqual({
      wiki: "{code}\n!https://x.io/p.png!\n[~jsmith]\n{code}",
      images: [],
      mentions: [],
    });
    const mixed = "{noformat}\n!https://x.io/a.png!\n{noformat}\n!https://x.io/b.png!";
    expect(safe(mixed).wiki).toBe(
      "{noformat}\n!https://x.io/a.png!\n{noformat}\n[https://x.io/b.png]",
    );
    expect(safe("{code:js}[~jsmith]{code} [~jsmith]").wiki).toBe(
      "{code:js}[~jsmith]{code} \\[~jsmith]",
    );
  });

  test("inline monospace is not a literal block, so it is still made safe", () => {
    expect(safe("{{!https://x.io/p.png!}}").wiki).toBe("{{[https://x.io/p.png]}}");
  });
});

describe("wikiSafetyWarning", () => {
  test("nothing changed, no warning", () => {
    expect(wikiSafetyWarning({ images: [], mentions: [] }, "comment")).toBeNull();
  });

  test("says what changed and where", () => {
    expect(
      wikiSafetyWarning({ images: ["https://a"], mentions: ["jsmith", "jsmith"] }, "comment"),
    ).toBe(
      "In the comment, 1 remote image became a link and the mention of jsmith became plain text (not a Jira user Secretary knows).",
    );
    expect(wikiSafetyWarning({ images: ["a", "b"], mentions: [] }, "description")).toBe(
      "In the description, 2 remote images became links.",
    );
  });
});

/**
 * An independent check of sanitised output, written apart from the sanitiser
 * (regexes over masked lines rather than a walk over cells): outside balanced,
 * lowercase, unescaped literal blocks there is no `{code}` / `{noformat}` marker
 * in any case, no unescaped `!` whose text up to the next unescaped `!` names a
 * remote target, and no unescaped `[` link with a part starting `~` that names a
 * user who is not known.
 */
function violations(wiki: string, knownIds: readonly (string | null)[] = known): string[] {
  const found: string[] = [];
  const knownSet = new Set(
    knownIds.flatMap((k) => (k ? [k.toLowerCase().replace(/^accountid:/, "")] : [])),
  );
  // The character after an even run of backslashes (or none).
  const unescaped = (ch: string) =>
    new RegExp(`${String.raw`(?<=(?:^|[^\\])(?:\\\\)*)`}\\${ch}`, "g");
  const block = () => /(?<=(?:^|[^\\])(?:\\\\)*)\{(code|noformat)(?::[^}\n]*)?\}([\s\S]*?)\{\1\}/g;
  const marker = /\{(?:code|noformat)(?![\w-])/i;

  if (marker.test(wiki.replace(block(), ""))) found.push("block marker outside a block");
  let masked = "";
  let last = 0;
  for (const m of wiki.matchAll(block())) {
    const content = m[2] ?? "";
    if (marker.test(content)) found.push(`block marker inside a block: ${m[0]}`);
    if (content.endsWith("\\")) found.push(`block closer after a backslash: ${m[0]}`);
    masked += wiki.slice(last, m.index);
    // Literal text still counts towards a span; its `!`, brackets and newlines do not.
    masked += m[0].replace(/[![\]\n]/g, " ").replaceAll("\\", "/");
    last = m.index + m[0].length;
  }
  masked += wiki.slice(last);

  const remote = (body: string) => {
    const s = body.replace(/[\t\r\n]/g, "").replaceAll("\\", "/");
    if (s.includes("//")) return true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] !== ":" || /\s/.test(s[i + 1] ?? " ")) continue;
      let start = i;
      while (start > 0 && /[a-z0-9+.-]/i.test(s[start - 1] ?? "")) start--;
      if (start < i && /[a-z]/i.test(s[start] ?? "")) return true;
    }
    return false;
  };
  for (const line of masked.split("\n")) {
    const bangs = [...line.matchAll(unescaped("!"))].map((m) => m.index);
    for (let i = 0; i + 1 < bangs.length; i++) {
      const body = line.slice((bangs[i] ?? 0) + 1, bangs[i + 1]);
      if (remote(body)) found.push(`image: !${body}!`);
    }
    const closes = [...line.matchAll(unescaped("]"))].map((m) => m.index);
    for (const m of line.matchAll(unescaped("["))) {
      const end = closes.find((c) => c > m.index);
      if (end === undefined) continue;
      for (const part of line.slice(m.index + 1, end).split("|")) {
        const t = part.trim().replace(/^\\+/, "");
        if (!t.startsWith("~")) continue;
        const id = t
          .slice(1)
          .trim()
          .toLowerCase()
          .replace(/^accountid:/, "")
          .trim();
        if (!knownSet.has(id)) found.push(`mention: ${line.slice(m.index, end + 1)}`);
      }
    }
  }
  return found;
}

describe("sanitiseProposalWiki: adversarial inputs", () => {
  const evil = "https://evil.example/p.png";
  /** Each is unsafe as written: the checker flags it before sanitising. */
  const cases: [name: string, wiki: string][] = [
    ["image", `!${evil}!`],
    ["image with attributes", `!${evil}|width=1,height=1!`],
    ["image with a title", `!${evil} "t"!`],
    ["protocol-relative image", "!//evil.example/p.png!"],
    ["upper-case image", "!HTTPS://EVIL.EXAMPLE/P.PNG!"],
    ["data image", "!data:image/png;base64,AAAA!"],
    ["scheme without slashes", "!https:evil.example/p.png!"],
    ["backslash for a slash", "!/\\evil.example/p.png!"],
    ["tab inside the scheme", "!ht\ttps://evil.example/p.png!"],
    ["image in brackets (Markdown autolink)", `![${evil}]!`],
    ["image in angle brackets", `!<${evil}>!`],
    ["image in quotes", `!"${evil}"!`],
    ["URL in an attribute", "!x.png|title=//evil.example/p.png!"],
    ["doubled bangs", `!!${evil}!!`],
    ["attachment then image", `!a.png! !${evil}!`],
    ["space after the bang", `! ${evil}!`],
    ["mention", "[~jsmith]"],
    ["Cloud mention", "[~accountid:557058:f00d]"],
    ["aliased mention", "[Bob|~jsmith]"],
    ["mention with a tooltip", "[Bob|~jsmith|tooltip]"],
    ["mention with a leading space", "[ ~jsmith]"],
    ["aliased mention with a space", "[Bob| ~jsmith]"],
    ["space after the tilde", "[~ jsmith]"],
    ["mention target first", "[~jsmith|https://x.io]"],
    ["nested bracket", "[[~jsmith]"],
    ["escaped tilde", "[\\~jsmith]"],
    ["upper-case code block", `{CODE}!${evil}!{CODE}`],
    ["mixed-case noformat block", "{NoFormat}[~jsmith]{NoFormat}"],
    ["mismatched case", `{code}x{CODE}!${evil}!{code}`],
    ["escaped block opener", `\\{code}!${evil}!{code}`],
    ["unclosed noformat", `{noformat}\n!${evil}!`],
    ["closer after a backslash", `{code}a\\{code}!${evil}!{code}`],
    ["closer with params", `{code:js}x{code:js}!${evil}!{code}`],
    ["block between bangs", `!x{code}y{code}${evil}!`],
  ];
  const wrappers: [string, (x: string) => string][] = [
    ["plain", (x) => x],
    ["table cell", (x) => `|${x}|b|`],
    ["table header", (x) => `||${x}||b||`],
    ["heading", (x) => `h2. ${x}`],
    ["bullet", (x) => `* ${x}`],
    ["numbered", (x) => `# ${x}`],
    ["quote", (x) => `{quote}${x}{quote}`],
    ["panel", (x) => `{panel:title=t}${x}{panel}`],
    ["color", (x) => `{color:red}${x}{color}`],
    ["monospace", (x) => `{{${x}}}`],
    ["after a code block", (x) => `{code}ok{code} ${x}`],
  ];
  const slashes = ["", "\\", "\\\\", "\\\\\\"];

  test.each(cases)("%s: unsafe before, flagged by the checker", (_name, wiki) => {
    expect(violations(wiki)).not.toEqual([]);
    expect(violations(`\\\\${wiki}`)).not.toEqual([]);
  });

  test.each(cases)("%s: safe in every wrapping and after 0-3 backslashes", (_name, wiki) => {
    for (const [wrapName, wrap] of wrappers)
      for (const s of slashes) {
        const input = wrap(`${s}${wiki}`);
        const once = safe(input).wiki;
        expect({ input, wrapName, found: violations(once) }).toEqual({
          input,
          wrapName,
          found: [],
        });
        // Idempotent: a second pass finds nothing more to change.
        expect(safe(once)).toEqual({ wiki: once, images: [], mentions: [] });
      }
  });

  test("an even run of backslashes is line breaks, so the token after it is live", () => {
    expect(safe(`\\\\!${evil}!`).wiki).toBe(`\\\\[${evil}]`);
    expect(safe("\\\\[~jsmith]")).toEqual({
      wiki: "\\\\\\[~jsmith]",
      images: [],
      mentions: ["jsmith"],
    });
    // An odd run escapes it, so Jira shows it as text and nothing changes.
    expect(safe(`\\\\\\!${evil}!`).wiki).toBe(`\\\\\\!${evil}!`);
    expect(safe("\\\\\\[~jsmith]").wiki).toBe("\\\\\\[~jsmith]");
  });

  test("an escaped or unbalanced block opener is broken up and its text made safe", () => {
    expect(safe(`\\{code}!${evil}!{code}`).wiki).toBe(`\\{ code}[${evil}]{ code}`);
    expect(safe(`{noformat}\n!${evil}!`).wiki).toBe(`{ noformat}\n[${evil}]`);
  });

  test("block markers in other cases are broken up, never trusted as blocks", () => {
    expect(safe(`{CODE}!${evil}!{CODE}`).wiki).toBe(`{ CODE}[${evil}]{ CODE}`);
    expect(safe("{NoFormat}[~jsmith]{NoFormat}").wiki).toBe("{ NoFormat}\\[~jsmith]{ NoFormat}");
  });

  test("a block's text cannot hold a second marker", () => {
    expect(safe(`{code}a\\{code}!${evil}!{code}`).wiki).toBe(`{code}a\\{ code}!${evil}!{code}`);
    expect(safe(`{noformat}{code:js}{noformat}`).wiki).toBe("{noformat}{ code:js}{noformat}");
  });

  test("every link whose target starts with ~ is a mention", () => {
    expect(safe("[Bob|~jsmith|tooltip] [ ~jsmith] [Bob| ~jsmith] [Ana| ~ana.b]")).toEqual({
      wiki: "\\[Bob|~jsmith|tooltip] \\[ ~jsmith] \\[Bob| ~jsmith] [Ana| ~ana.b]",
      images: [],
      mentions: ["jsmith", "jsmith", "jsmith"],
    });
  });

  test("an image in any wrapping loses its bang; a stretched span is caught too", () => {
    expect(fromMd(`![](<${evil}>)`)).toEqual({
      wiki: `\\![${evil}]!`,
      images: [evil],
      mentions: [],
    });
    expect(safe(`!!${evil}!!`).wiki).toBe(`\\![${evil}]!`);
    expect(safe(`!a.png! !data:x! ok`).wiki).toBe("\\!a.png\\! \\!data:x! ok");
  });

  test("Markdown inputs come out safe after conversion", () => {
    for (const md of [
      `![](<${evil}>)`,
      `![x](${evil} "t")`,
      `[![badge](${evil})](https://x.io)`,
      "Ping [~jsmith] and [Bob|~jsmith|tip]",
      "```\nunclosed fence\n\n![](https://evil.example/q.png)",
      "Use `{code}` here ![](//evil.example/p.png)",
      `\\\\![](${evil})`,
    ])
      expect({ md, found: violations(fromMd(md).wiki) }).toEqual({ md, found: [] });
  });

  test("safe text passes through unchanged", () => {
    for (const wiki of [
      "h2. Plan\n\n*bold* _it_ {{mono}} [site|https://x.io] [https://x.io]",
      "||a||b||\n|1|PAY-2|\n* one\n# two",
      "{quote}Hi [~ana.b]{quote} {panel:title=t}x{panel} {color:red}y{color}",
      `{code:js}\n!${evil}!\n[~jsmith]\n{code}`,
      "{noformat}\n{ code}\n{noformat}",
      "Great! Thanks! See !screenshot.png! and !a.png|thumbnail!",
      "Line one\\\\Line two, C:\\temp and 10:30!",
    ]) {
      expect(safe(wiki)).toEqual({ wiki, images: [], mentions: [] });
      expect(violations(wiki)).toEqual([]);
    }
  });
});

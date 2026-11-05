import { describe, expect, test } from "bun:test";
import { blockForModel, blockImageLinks, imageLinks, insertImageLink } from "./images";

const targets = (line: string) => imageLinks(line).map((l) => l.target);

describe("imageLinks (D70)", () => {
  test("Obsidian's wikilinks, with width and anchor parts parsed off", () => {
    expect(targets("![[Pasted image 20261105093000.png]]")).toEqual([
      "Pasted image 20261105093000.png",
    ]);
    expect(targets("![[shot.png|300]]")).toEqual(["shot.png"]);
    expect(targets("![[shot.jpg#x]]")).toEqual(["shot.jpg"]);
    expect(targets("![[Files/a b.webp|100x50]]")).toEqual(["Files/a b.webp"]);
  });

  test("markdown links in angle brackets or percent-encoded, decoded", () => {
    expect(targets("![](<Files/Pasted image 1.png>)")).toEqual(["Files/Pasted image 1.png"]);
    expect(targets("![alt](Pasted%20image%201.png)")).toEqual(["Pasted image 1.png"]);
    expect(targets('![a](../assets/x.gif "title")')).toEqual(["../assets/x.gif"]);
    expect(targets("![](bad%E0.png)")).toEqual(["bad%E0.png"]);
  });

  test("only local files with an image extension", () => {
    expect(targets("![[Meeting notes]]")).toEqual([]);
    expect(targets("![[doc.pdf]]")).toEqual([]);
    expect(targets("![[icon.svg]]")).toEqual([]);
    expect(targets("[[a.png]] and [x](a.png)")).toEqual([]);
    expect(targets("![](https://example.com/a.png)")).toEqual([]);
    expect(targets("![](data:image/png;base64,AAAA.png)")).toEqual([]);
    expect(targets("![[A.JPEG]]")).toEqual(["A.JPEG"]);
  });

  test("backslashes, drives and NUL are never asked for", () => {
    expect(targets("![[\\\\evil\\s\\a.png]]")).toEqual([]);
    expect(targets("![](\\\\evil\\s\\a.png)")).toEqual([]);
    expect(targets("![](<C:/Users/me/a.png>)")).toEqual([]);
    expect(targets("![[C:a.png]]")).toEqual([]);
    expect(targets("![](a%00.png)")).toEqual([]);
    expect(targets("![](%5C%5Cevil%5Cs%5Ca.png)")).toEqual([]);
    // `..` is text here; Rust works it out and refuses a climb out of the vault.
    expect(targets("![[../Files/a.png]]")).toEqual(["../Files/a.png"]);
  });

  test("Obsidian's escaped pipe in tables, anchors before decoding, parentheses", () => {
    expect(targets("| ![[a.png\\|300]] |")).toEqual(["a.png"]);
    expect(targets("![](a%23b.png#frag)")).toEqual(["a#b.png"]);
    expect(targets("![](Files/shot%20(1).png)")).toEqual(["Files/shot (1).png"]);
  });

  test("in order, with their ranges and names", () => {
    const line = "see ![](b%20c.png) then ![[Files/a.png|20]]";
    const links = imageLinks(line);
    expect(links.map((l) => l.target)).toEqual(["b c.png", "Files/a.png"]);
    expect(links.map((l) => line.slice(l.from, l.to))).toEqual([
      "![](b%20c.png)",
      "![[Files/a.png|20]]",
    ]);
    expect(links.map((l) => l.name)).toEqual(["b c.png", "a.png"]);
  });
});

describe("insertImageLink (D70)", () => {
  const apply = (doc: string, cursor: number, link: string) => {
    const r = insertImageLink(doc, cursor, link);
    const text = doc.slice(0, r.changes.from) + r.changes.insert + doc.slice(r.changes.from);
    return { text, cursor: r.cursor };
  };

  test("an empty line takes the link, the cursor goes to the line after", () => {
    expect(apply("one\n\ntwo", 4, "![[a.png]]")).toEqual({
      text: "one\n![[a.png]]\n\ntwo",
      cursor: 15,
    });
    expect(apply("", 0, "![[a.png]]")).toEqual({ text: "![[a.png]]\n", cursor: 11 });
  });

  test("after text on the line, the link starts a new line", () => {
    expect(apply("see this", 8, "![[a.png]]")).toEqual({
      text: "see this\n![[a.png]]\n",
      cursor: 20,
    });
    expect(apply("see this", 3, "![[a.png]]")).toEqual({
      text: "see\n![[a.png]]\n this",
      cursor: 15,
    });
  });

  test("two images in a row stack on their own lines", () => {
    const first = apply("note: ", 6, "![[a.png]]");
    const second = apply(first.text, first.cursor, "![[b.png]]");
    expect(second.text).toBe("note: \n![[a.png]]\n![[b.png]]\n");
  });
});

describe("a block as the model reads it (D71)", () => {
  const reads = new Map([
    [
      "chat.png",
      {
        description: "A Teams chat where Dana asks for the Q3 numbers.",
        text: "Dana (10:02): can you send me the Q3 numbers?\n\nSam (10:05): by Friday",
      },
    ],
    ["board.png", { description: "A photo of a whiteboard with no text.", text: "" }],
  ]);

  test("a link alone on its line becomes the quote, the user's words stay as they are", () => {
    expect(blockForModel("ask Dana about this\n![[chat.png]]", reads)).toBe(
      [
        "ask Dana about this",
        "> [Image: chat.png: A Teams chat where Dana asks for the Q3 numbers.]",
        "> Dana (10:02): can you send me the Q3 numbers?",
        ">",
        "> Sam (10:05): by Friday",
      ].join("\n"),
    );
  });

  test("a link inside a line with words: the words stay, the quote follows", () => {
    expect(blockForModel("- [ ] answer ![](chat.png) today", reads)).toBe(
      [
        "- [ ] answer today",
        "> [Image: chat.png: A Teams chat where Dana asks for the Q3 numbers.]",
        "> Dana (10:02): can you send me the Q3 numbers?",
        ">",
        "> Sam (10:05): by Friday",
      ].join("\n"),
    );
  });

  test("two links: two quotes in order; a link without a transcript stays a link", () => {
    expect(blockForModel("![[board.png]] ![[chat.png|300]] ![[other.png]]", reads)).toBe(
      [
        "![[other.png]]",
        "> [Image: board.png: A photo of a whiteboard with no text.]",
        "> [Image: chat.png: A Teams chat where Dana asks for the Q3 numbers.]",
        "> Dana (10:02): can you send me the Q3 numbers?",
        ">",
        "> Sam (10:05): by Friday",
      ].join("\n"),
    );
    expect(blockForModel("- ![[board.png]]", reads)).toBe(
      "> [Image: board.png: A photo of a whiteboard with no text.]",
    );
  });

  test("without transcripts the text is unchanged; the links of a block in order", () => {
    const text = "see ![[b.png]]\n![a](a%20b.jpg) and ![[c.gif]]";
    expect(blockForModel(text, new Map())).toBe(text);
    expect(blockImageLinks(text).map((l) => l.target)).toEqual(["b.png", "a b.jpg", "c.gif"]);
  });
});

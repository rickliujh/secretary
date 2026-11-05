import { describe, expect, test } from "bun:test";
import { imageLinks, insertImageLink } from "./images";

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

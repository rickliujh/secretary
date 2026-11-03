import { describe, expect, test } from "bun:test";
import { splitBlocks } from "./blocks";
import { mergeNote } from "./merge";

const base = "one\ntwo\nthree\n";

describe("mergeNote (D65)", () => {
  test("one side changed: that side wins", () => {
    expect(mergeNote(base, base, "one\ntwo\nthree\nfrom obsidian\n")).toEqual({
      text: "one\ntwo\nthree\nfrom obsidian\n",
      conflict: false,
    });
    expect(mergeNote(base, "one\ntwo\nthree\nfrom page\n", base)).toEqual({
      text: "one\ntwo\nthree\nfrom page\n",
      conflict: false,
    });
  });

  test("both changed different places: both kept", () => {
    const r = mergeNote(base, "zero\none\ntwo\nthree\n", "one\ntwo\nthree\nfour\n");
    expect(r).toEqual({ text: "zero\none\ntwo\nthree\nfour\n", conflict: false });
  });

  test("both added at the same place: both kept, the file's first, a blank line between", () => {
    const r = mergeNote(base, `${base}page line\n`, `${base}file line\n`);
    expect(r).toEqual({ text: `${base}file line\n\npage line\n`, conflict: false });
  });

  test("both changed the same line: both versions kept as their own paragraphs, a conflict", () => {
    const r = mergeNote(base, "one\nTWO page\nthree\n", "one\nTWO file\nthree\n");
    expect(r).toEqual({ text: "one\nTWO file\n\nTWO page\n\nthree\n", conflict: true });
  });

  test("the same edit on both sides is no conflict", () => {
    const r = mergeNote(base, "one\n2\nthree\nx\n", "one\n2\nthree\ny\n");
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("one\n2\nthree\ny\n\nx\n");
  });

  test("first connect (empty base): both kept, the file's first, shared lines once", () => {
    expect(mergeNote("", "page only\n", "file only\n")).toEqual({
      text: "file only\n\npage only\n",
      conflict: false,
    });
    expect(mergeNote("", "same\n", "same\n").text).toBe("same\n");
    expect(mergeNote("", "", "file\n").text).toBe("file\n");
    expect(mergeNote("", "page\n", "").text).toBe("page\n");
  });

  test("the page's blank lines survive, so its paragraphs stay their own blocks", () => {
    const r = mergeNote("a\n", "a\n\nmine1\n\nmine2\n", "a\n\ntheirs\n");
    expect(r.text).toBe("a\n\ntheirs\n\nmine1\n\nmine2\n");
    expect(splitBlocks(r.text).map((b) => b.text)).toEqual(["a", "theirs", "mine1", "mine2"]);
  });

  test("a deletion on one side is kept", () => {
    expect(mergeNote(base, "one\nthree\n", base).text).toBe("one\nthree\n");
    expect(mergeNote(base, `${base}x\n`, "one\nthree\n").text).toBe("one\nthree\nx\n");
  });
});

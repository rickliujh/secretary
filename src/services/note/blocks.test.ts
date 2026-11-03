import { describe, expect, test } from "bun:test";
import { hashText, normaliseBlock, similarity, splitBlocks, withoutPrivate } from "./blocks";

const NOTE = `---
tags: [daily]
---
# Tuesday

PAY-12: Sarah says the cert is Friday now
and she will send it by mail

- [ ] send Dana the Q3 numbers
- [x] book the room
  with the projector
* Lunch with Mia
1. first numbered

\`\`\`
code line one

code line two
\`\`\`

## Private
- dentist at 4
### Health
gym
## Work again
> Ana wrote: please review
my take: fine
`;

describe("splitBlocks (D65)", () => {
  const blocks = splitBlocks(NOTE);

  test("paragraphs, list items, fences; headings name sections; frontmatter skipped", () => {
    expect(blocks.map((b) => b.text)).toEqual([
      "PAY-12: Sarah says the cert is Friday now\nand she will send it by mail",
      "- [ ] send Dana the Q3 numbers",
      "- [x] book the room\n  with the projector",
      "* Lunch with Mia",
      "1. first numbered",
      "```\ncode line one\n\ncode line two\n```",
      "- dentist at 4",
      "gym",
      "> Ana wrote: please review\nmy take: fine",
    ]);
    expect(blocks.map((b) => b.section)).toEqual([
      "Tuesday",
      "Tuesday",
      "Tuesday",
      "Tuesday",
      "Tuesday",
      "Tuesday",
      "Private",
      "Health",
      "Work again",
    ]);
    expect(blocks.map((b) => b.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("the private heading covers its subheadings until a heading of its level", () => {
    expect(blocks.filter((b) => b.private).map((b) => b.text)).toEqual(["- dentist at 4", "gym"]);
    const custom = splitBlocks("# Mine\nsecret\n# Open\nfree", "mine");
    expect(custom.map((b) => [b.text, b.private])).toEqual([
      ["secret", true],
      ["free", false],
    ]);
  });

  test("each block knows its lines, after frontmatter and around blank lines (D67)", () => {
    expect(blocks.map((b) => [b.fromLine, b.toLine])).toEqual([
      [5, 6],
      [8, 8],
      [9, 10],
      [11, 11],
      [12, 12],
      [14, 18],
      [21, 21],
      [23, 23],
      [25, 26],
    ]);
    const lines = NOTE.split("\n");
    for (const b of blocks)
      expect(
        lines
          .slice(b.fromLine, b.toLine + 1)
          .join("\n")
          .trim(),
      ).toBe(b.text);
  });

  test("line ranges count blank lines, CRLF and an empty first line", () => {
    const b = splitBlocks("\r\n\r\nfirst\r\nstill first\r\n\r\n\r\n- item\r\n\r\n  ");
    expect(b.map((x) => [x.text, x.fromLine, x.toLine])).toEqual([
      ["first\nstill first", 2, 3],
      ["- item", 6, 6],
    ]);
  });

  test("checkboxes: state and the unticked twin's hash", () => {
    const [, open, done] = blocks;
    expect(open?.checked).toBe(false);
    expect(open?.uncheckedHash).toBe(open?.hash ?? "");
    expect(done?.checked).toBe(true);
    const ticked = splitBlocks("- [X] send Dana the Q3 numbers")[0];
    expect(ticked?.checked).toBe(true);
    expect(ticked?.uncheckedHash).toBe(open?.hash ?? "");
    expect(blocks[3]?.checked).toBeNull();
  });

  test("the same words hash the same wherever and however spaced", () => {
    const a = splitBlocks("intro\n\n  Lunch   with Mia  ")[1];
    const b = splitBlocks("Lunch with Mia")[0];
    expect(a?.hash).toBe(b?.hash ?? "");
    expect(normaliseBlock("  a  b \n\n c ")).toBe("a b\nc");
    expect(hashText("x")).not.toBe(hashText("y"));
    expect(hashText("x")).toHaveLength(14);
  });

  test("an unclosed fence is no fence: the private heading after it still counts", () => {
    const b = splitBlocks("work\n\n```\ncode\n\n## Private\nsalary\n");
    expect(b.map((x) => [x.text, x.private])).toEqual([
      ["work", false],
      ["```\ncode", false],
      ["salary", true],
    ]);
    // A closed fence still holds its blank lines and a heading-like line.
    const closed = splitBlocks("```\na\n\n## not a heading\n```\nafter");
    expect(closed.map((x) => x.text)).toEqual(["```\na\n\n## not a heading\n```", "after"]);
  });

  test("a leading --- is frontmatter only over key: lines; else a rule", () => {
    expect(splitBlocks("---\nhr above\n\nline\n\n---\n\nafter").map((b) => b.text)).toEqual([
      "---\nhr above",
      "line",
      "---",
      "after",
    ]);
    expect(
      splitBlocks("---\ntags:\n  - daily\ndate: 2026-11-02\n---\nbody").map((b) => b.text),
    ).toEqual(["body"]);
  });

  test("withoutPrivate drops the private sections, headings and fences read the same way", () => {
    const note = "# Day\nwork line\n## Private\nsalary\n### Health\ngym\n## Work\nmore\n";
    expect(withoutPrivate(note)).toBe("# Day\nwork line\n## Work\nmore\n");
    expect(withoutPrivate("```\n## Private\n```\nok\n## Private\nhidden")).toBe(
      "```\n## Private\n```\nok",
    );
    expect(withoutPrivate("work\n\n```\ncode\n## Private\nsalary")).toBe("work\n\n```\ncode");
  });

  test("empty items and headings alone are no blocks", () => {
    expect(splitBlocks("# Only a heading\n\n- [ ]\n-\n\n")).toEqual([]);
    expect(splitBlocks("")).toEqual([]);
  });

  test("similarity is word overlap", () => {
    expect(similarity("send Dana the numbers", "send Dana the Q3 numbers")).toBeCloseTo(0.8);
    expect(similarity("a", "b")).toBe(0);
  });
});

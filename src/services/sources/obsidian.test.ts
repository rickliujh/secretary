import { describe, expect, test } from "bun:test";
import { isExcluded } from "./exclude";
import {
  markdownLinkTarget,
  normalizeTag,
  parseNote,
  splitFrontmatter,
  wikilinkTarget,
} from "./obsidian";

describe("splitFrontmatter", () => {
  test("parses YAML between leading --- lines", () => {
    const r = splitFrontmatter("---\ntitle: Hello\ncount: 3\n---\n# Body\n");
    expect(r.frontmatter).toEqual({ title: "Hello", count: 3 });
    expect(r.body).toBe("# Body\n");
  });

  test("handles CRLF, a BOM and empty frontmatter", () => {
    expect(splitFrontmatter("﻿---\r\na: 1\r\n---\r\nText").frontmatter).toEqual({ a: 1 });
    expect(splitFrontmatter("---\n---\nText")).toEqual({ frontmatter: null, body: "Text" });
  });

  test("invalid YAML counts as no frontmatter and keeps the text", () => {
    const text = '---\ntitle: "unclosed\ntags: [a, b\n---\nBody';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  test("--- that is not at the start, or never closed, is body", () => {
    expect(splitFrontmatter("Intro\n---\na: 1\n---\n").frontmatter).toBeNull();
    expect(splitFrontmatter("---\na: 1\nno end").frontmatter).toBeNull();
  });

  test("a scalar document is not frontmatter but is still stripped", () => {
    expect(splitFrontmatter("---\njust text\n---\nBody")).toEqual({
      frontmatter: null,
      body: "Body",
    });
  });
});

describe("parseNote title and aliases", () => {
  test("title from frontmatter, else the file name", () => {
    expect(parseNote("A/B/My note.md", "---\ntitle: Real title\n---\nx").title).toBe("Real title");
    expect(parseNote("A/B/My note.md", "---\ntitle: 42\n---\nx").title).toBe("My note");
    expect(parseNote("A/B/My note.md", "x").title).toBe("My note");
  });

  test("aliases from aliases or alias, as a list or a string", () => {
    expect(parseNote("n.md", "---\naliases: [One, Two]\n---\n").aliases).toEqual(["One", "Two"]);
    expect(parseNote("n.md", "---\nalias: One, Two\n---\n").aliases).toEqual(["One", "Two"]);
    expect(parseNote("n.md", "---\naliases:\n  - One\n  - one\n---\n").aliases).toEqual(["One"]);
    expect(parseNote("n.md", "no frontmatter").aliases).toEqual([]);
  });
});

describe("parseNote tags", () => {
  test("frontmatter tags as a list, a comma or space separated string, with #", () => {
    expect(parseNote("n.md", "---\ntags: [Project, '#finance/ledger']\n---\n").tags).toEqual([
      "project",
      "finance/ledger",
    ]);
    expect(parseNote("n.md", "---\ntags: one, two three\n---\n").tags).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(parseNote("n.md", "---\ntag: solo\n---\n").tags).toEqual(["solo"]);
  });

  test("inline tags with nesting, lower-cased and deduped with frontmatter", () => {
    const n = parseNote("n.md", "---\ntags: [ops]\n---\nFix it #OPS and #ops/certs, also #y1984.");
    expect(n.tags).toEqual(["ops", "ops/certs", "y1984"]);
  });

  test("not tags: numbers, headings, URL fragments, code and mid-word #", () => {
    const text = [
      "# Heading",
      "## Another #real",
      "Issue #1984 and C# and a#b",
      "See https://example.com/page#section",
      "Inline `#code` here",
      "```",
      "#fenced",
      "```",
      "    #indented",
      "<!-- #commented -->",
    ].join("\n");
    expect(parseNote("n.md", text).tags).toEqual(["real"]);
  });

  test("normalizeTag", () => {
    expect(normalizeTag("#Area/Sub/")).toBe("area/sub");
    expect(normalizeTag("2024")).toBeNull();
    expect(normalizeTag("has space")).toBeNull();
    expect(normalizeTag("")).toBeNull();
  });
});

describe("parseNote links", () => {
  test("wikilinks drop heading, block and alias parts; embeds count; folders kept", () => {
    const text = [
      "[[Ledger export]] and [[Ledger export|the export]]",
      "[[Projects/Ledger export#Decisions]] ![[Diagram note]] [[Note^abc123]]",
      "[[Table link\\|alias]] [[#Local heading]] ![[chart.png]] [[Spec.md]]",
    ].join("\n");
    expect(parseNote("n.md", text).links).toEqual([
      "Ledger export",
      "Projects/Ledger export",
      "Diagram note",
      "Note",
      "Table link",
      "Spec",
    ]);
  });

  test("Markdown links to local .md files, relative ones resolved", () => {
    const text = [
      "[spec](../Projects/Ledger%20export.md)",
      "[same](./Sibling.md#part) [root](Areas/Finance.md)",
      "[web](https://example.com/a.md) [anchor](#top) [file](report.pdf)",
      "",
      "[ref]: <Other note.md>",
    ].join("\n");
    expect(parseNote("Meetings/Sync.md", text).links).toEqual([
      "Projects/Ledger export",
      "Meetings/Sibling",
      "Areas/Finance",
      "Other note",
    ]);
  });

  test("links in code are ignored, links in frontmatter properties count", () => {
    const text = "---\nowner: '[[Dana Kim]]'\n---\n`[[Inline]]`\n```\n[[Fenced]]\n```\n[[Real]]";
    expect(parseNote("n.md", text).links).toEqual(["Dana Kim", "Real"]);
  });

  test("helpers", () => {
    expect(wikilinkTarget("A/B#h|x")).toBe("A/B");
    expect(wikilinkTarget("#h")).toBeNull();
    expect(markdownLinkTarget("n.md", "mailto:x@y.z")).toBeNull();
  });
});

test("body keeps the Markdown without frontmatter", () => {
  const n = parseNote("n.md", "---\na: 1\n---\n# Title\n\nText");
  expect(n.body).toBe("# Title\n\nText");
  expect(n.frontmatter).toEqual({ a: 1 });
});

describe("isExcluded", () => {
  test("dot folders and dot files anywhere are always excluded", () => {
    expect(isExcluded(".obsidian/workspace.md", [])).toBe(true);
    expect(isExcluded("Projects/.trash/old.md", [])).toBe(true);
    expect(isExcluded("Projects/.hidden.md", [])).toBe(true);
    expect(isExcluded("Projects/a.b.md", [])).toBe(false);
  });

  test("entries match a folder prefix or an exact file, case-insensitively", () => {
    const ex = ["private/", "/Journal/2024", "Inbox/Scratch.md", "  "];
    expect(isExcluded("Private/Salary.md", ex)).toBe(true);
    expect(isExcluded("Journal/2024/01.md", ex)).toBe(true);
    expect(isExcluded("Journal/2025/01.md", ex)).toBe(false);
    expect(isExcluded("Inbox/Scratch.md", ex)).toBe(true);
    expect(isExcluded("Inbox/Other.md", ex)).toBe(false);
    expect(isExcluded("PrivateNotes/x.md", ex)).toBe(false);
  });

  test("Windows separators and ./ in entries", () => {
    expect(isExcluded("Private/Sub/x.md", ["Private\\Sub"])).toBe(true);
    expect(isExcluded("Private/x.md", ["./Private"])).toBe(true);
  });
});

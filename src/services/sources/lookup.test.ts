import { describe, expect, test } from "bun:test";
import { backlinks, hitSnippet, normalizeTarget, resolveNote, titleMatches } from "./lookup";

const notes = [
  { path: "Projects/Ledger export.md", title: "Ledger export", aliases: ["Ledger CSV"] },
  { path: "Archive/Projects/Ledger export.md", title: "Old ledger", aliases: [] },
  { path: "People/Dana Kim.md", title: "Dana", aliases: [] },
];

describe("resolveNote", () => {
  test("path, file name (shortest path first), title, alias", () => {
    expect(resolveNote("Projects/Ledger export.md", notes)?.path).toBe(notes[0].path);
    expect(resolveNote("archive/projects/ledger export", notes)?.path).toBe(notes[1].path);
    expect(resolveNote("ledger export", notes)?.path).toBe(notes[0].path);
    expect(resolveNote("Dana Kim", notes)?.path).toBe(notes[2].path);
    expect(resolveNote("Dana", notes)?.path).toBe(notes[2].path);
    expect(resolveNote("ledger csv", notes)?.path).toBe(notes[0].path);
    expect(resolveNote("[[Ledger CSV#Decisions|x]]", notes)?.path).toBe(notes[0].path);
    expect(resolveNote("Nope", notes)).toBeNull();
    expect(resolveNote("  ", notes)).toBeNull();
  });

  test("normalizeTarget", () => {
    expect(normalizeTarget("![[Projects/A.md#h]]")).toBe("projects/a");
    expect(normalizeTarget("./Projects\\A")).toBe("projects/a");
  });
});

test("backlinks match title, path, file name or alias, not the note itself", () => {
  const note = notes[0];
  const others = [
    { path: "Meetings/Sync.md", title: "Sync", links: ["ledger export"] },
    { path: "Daily/1.md", title: "Daily 1", links: ["Ledger CSV"] },
    { path: "Meetings/Spec.md", title: "Spec", links: ["Projects/Ledger export"] },
    { path: "People/Dana Kim.md", title: "Dana", links: ["Something else"] },
    { path: note.path, title: note.title, links: ["Ledger export"] },
  ];
  expect(backlinks(note, others)).toEqual(["Sync", "Daily 1", "Spec"]);
});

test("hitSnippet collapses whitespace and falls back to the body start", () => {
  expect(hitSnippet("…the\nexport  is…", "body")).toBe("…the export is…");
  expect(hitSnippet("", "Short body\n\ntext")).toBe("Short body text");
  expect(hitSnippet(null, "x".repeat(300))).toBe(`${"x".repeat(240)}…`);
  expect(hitSnippet("…", "fallback")).toBe("fallback");
});

test("titleMatches counts query words that start a title, alias or file name word", () => {
  expect(titleMatches(["ledger", "export", "retention"], ["Ledger export", "Ledger CSV"])).toBe(2);
  expect(titleMatches(["ledg"], ["Ledger export"])).toBe(1);
  expect(titleMatches(["retention"], ["2026-09-21 Planning"])).toBe(0);
});

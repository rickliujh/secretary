import { describe, expect, test } from "bun:test";
import { buildNoteTriageSchema, NO_ITEM, validateNoteTriage } from "@/prompts/note-triage";
import { NOTE_EVAL_CASES, noteEvalInput, scoreNoteCase } from "./note-cases";

describe("note_triage eval cases", () => {
  test("a dozen blocks or more, of every kind, items among the case's candidates", () => {
    const blocks = NOTE_EVAL_CASES.flatMap((c) => c.blocks);
    expect(blocks.length).toBeGreaterThanOrEqual(12);
    for (const kind of ["act", "context", "skip"])
      expect(blocks.some((b) => b.expect === kind)).toBe(true);
    for (const c of NOTE_EVAL_CASES)
      for (const b of c.blocks)
        if (b.expect === "context") expect(c.items.map((i) => i.id)).toContain(b.item ?? "");
  });

  test("the expected answer is valid, scores clean, and a wrong kind is reported", () => {
    for (const c of NOTE_EVAL_CASES) {
      const input = noteEvalInput(c);
      const ids = input.items.map((i) => i.id);
      const answer = {
        blocks: c.blocks.map((b, i) => ({
          index: String(i + 1),
          kind: b.expect,
          item: b.expect === "context" ? (b.item ?? NO_ITEM) : NO_ITEM,
          thread: b.thread ?? NO_ITEM,
        })),
      };
      const threadIds = (input.threads ?? []).map((t) => t.id);
      expect(buildNoteTriageSchema(c.blocks.length, ids, threadIds).safeParse(answer).success).toBe(
        true,
      );
      expect(validateNoteTriage(answer, c.blocks.length, ids, threadIds)).toEqual([]);
      expect(scoreNoteCase(c, answer)).toEqual([]);
      const wrong = {
        blocks: answer.blocks.map((b) => ({ ...b, kind: "skip" as const, item: NO_ITEM })),
      };
      expect(scoreNoteCase(c, wrong).length).toBeGreaterThan(0);
    }
    expect(scoreNoteCase(NOTE_EVAL_CASES[0] ?? { name: "", blocks: [], items: [] }, null)).toEqual([
      "no valid answer",
    ]);
  });

  test("a thread case: one block continues a listed thread, one is new work, one is context (D66)", () => {
    const threaded = NOTE_EVAL_CASES.filter((c) => c.threads?.length);
    expect(threaded).toHaveLength(1);
    const c = threaded[0];
    const ids = (c?.threads ?? []).map((t) => t.id);
    const continuing = c?.blocks.filter((b) => b.thread) ?? [];
    expect(continuing).toHaveLength(1);
    expect(ids).toContain(continuing[0]?.thread ?? "");
    expect(c?.blocks.some((b) => b.expect === "act" && !b.thread)).toBe(true);
    expect(c?.blocks.some((b) => b.expect === "context")).toBe(true);
    // No block names a ticket: code would route that one itself.
    for (const b of c?.blocks ?? []) expect(b.text).not.toMatch(/[A-Z]+-\d+/);
    const answer = {
      blocks: (c?.blocks ?? []).map((b, i) => ({
        index: String(i + 1),
        kind: b.expect,
        item: b.item ?? NO_ITEM,
        thread: NO_ITEM,
      })),
    };
    expect(scoreNoteCase(c ?? { name: "", blocks: [], items: [] }, answer)[0]).toContain(
      "thread none, expected t-cert",
    );
  });
});

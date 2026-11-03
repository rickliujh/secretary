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
        })),
      };
      expect(buildNoteTriageSchema(c.blocks.length, ids).safeParse(answer).success).toBe(true);
      expect(validateNoteTriage(answer, c.blocks.length, ids)).toEqual([]);
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
});

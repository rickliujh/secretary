/**
 * Eval cases for `note_triage` (Phase 29, D65): readings of a daily note, each
 * one call over its blocks with the work items code would list. Each block
 * names the kind it should get (and, for context, the item); a reading passes
 * when every block does.
 */
import type { NoteKind, NoteTriageInput, NoteTriageOutput } from "@/prompts/note-triage";
import { noteDecisions } from "@/prompts/note-triage";

export type NoteEvalBlock = {
  text: string;
  section?: string;
  expect: NoteKind;
  /** For context: the item id it belongs to. */
  item?: string;
};

export type NoteEvalCase = {
  name: string;
  blocks: NoteEvalBlock[];
  items: NoteTriageInput["items"];
};

const TODAY = "2026-11-02";

const CERT = {
  id: "w-cert",
  name: "Renew the payment gateway cert",
  tickets: ["PAY-12", "PLAT-812"],
  now: "Waiting on Platform (PLAT-812) for the new cert; Sarah is getting it",
  current: true,
};
const LEDGER = {
  id: "w-ledger",
  name: "Ledger export for credit notes",
  tickets: ["PAY-31", "PAY-32"],
  now: "Export job written; testing against the staging ledger",
  current: false,
};
const ONCALL = {
  id: "w-oncall",
  name: "On-call runbook refresh",
  tickets: ["OPS-7"],
  now: null,
  current: false,
};

export const NOTE_EVAL_CASES: NoteEvalCase[] = [
  {
    name: "a working morning",
    items: [CERT, LEDGER, ONCALL],
    blocks: [
      { text: "PAY-12: Sarah says the cert is Friday now", expect: "act" },
      { text: "Lunch with Mia", expect: "skip" },
      { text: "- [ ] send Dana the Q3 numbers", expect: "act" },
      {
        text: "ledger export: staging run went fine, about half the credit notes checked",
        expect: "context",
        item: "w-ledger",
      },
      { text: "https://example.com/some-article-to-read-later", expect: "skip" },
    ],
  },
  {
    name: "after the standup",
    items: [CERT, LEDGER, ONCALL],
    blocks: [
      { text: "Standup", section: "Standup", expect: "skip" },
      {
        text: "Told Omar I'd review his runbook PR by Thursday",
        section: "Standup",
        expect: "act",
      },
      {
        text: "PAY-31 is blocked until finance gives us the account mapping, need to chase Priya",
        section: "Standup",
        expect: "act",
      },
      { text: "feeling tired today, too much coffee", expect: "skip" },
      {
        text: "OPS-7 runbook: rewrote the paging section, reads better now",
        expect: "context",
        item: "w-oncall",
      },
    ],
  },
  {
    name: "an evening of loose lines",
    items: [CERT, LEDGER],
    blocks: [
      { text: "gym at 6, then groceries", expect: "skip" },
      {
        text: "Ana wrote:\n> can you move the cert rotation to next sprint? we're swamped",
        expect: "act",
      },
      { text: "- [ ] book flights for the offsite", expect: "act" },
      { text: "idea: maybe we should write more docs someday", expect: "skip" },
      {
        text: "cert work going ok, nothing new from Platform yet",
        expect: "context",
        item: "w-cert",
      },
    ],
  },
];

export const noteEvalInput = (c: NoteEvalCase): NoteTriageInput => ({
  blocks: c.blocks.map((b) => ({ text: b.text, section: b.section ?? null, date: TODAY })),
  items: c.items,
  today: TODAY,
});

/** What went wrong per block; empty when every block got its kind (and item). */
export function scoreNoteCase(c: NoteEvalCase, out: NoteTriageOutput | null): string[] {
  if (!out) return ["no valid answer"];
  const decisions = noteDecisions(out, c.blocks.length);
  return c.blocks.flatMap((b, i) => {
    const d = decisions.find((x) => x.index === i);
    const label = `"${b.text.split("\n")[0]?.slice(0, 40)}"`;
    if (!d) return [`${label}: no answer`];
    if (d.kind !== b.expect) return [`${label}: ${d.kind}, expected ${b.expect}`];
    if (d.kind === "context" && d.itemId !== b.item)
      return [`${label}: on ${d.itemId}, expected ${b.item}`];
    return [];
  });
}

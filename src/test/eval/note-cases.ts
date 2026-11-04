/**
 * Eval cases for `note_triage` (Phase 29, D65): readings of a daily note, each
 * one call over its blocks with the work items code would list. Each block
 * names the kind it should get (and, for context, the item; for act, the
 * earlier note thread it continues, D66); a reading passes when every block
 * does.
 */
import type {
  NoteKind,
  NoteTriageInput,
  NoteTriageOutput,
  NoteTriageThread,
} from "@/prompts/note-triage";
import { noteDecisions } from "@/prompts/note-triage";

export type NoteEvalBlock = {
  text: string;
  section?: string;
  expect: NoteKind;
  /** For context: the item id it belongs to. */
  item?: string;
  /** For act: the listed thread it continues (D66); absent: a new one. */
  thread?: string;
};

export type NoteEvalCase = {
  name: string;
  blocks: NoteEvalBlock[];
  items: NoteTriageInput["items"];
  /** Earlier note threads code would list (D66); absent: none. */
  threads?: NoteTriageThread[];
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

/** The note's earlier conversations of the thread case (D66). */
const CERT_THREAD: NoteTriageThread = {
  id: "t-cert",
  date: "2026-10-30",
  summary: "Sarah expects the new payment gateway cert from Platform on Friday",
  tickets: ["PAY-12"],
};
const QODER_THREAD: NoteTriageThread = {
  id: "t-qoder",
  date: "2026-10-28",
  summary: "Create an epic for the Qoder migration of the merchant SDK",
  tickets: ["PAY-40"],
};

/** The work item and the conversation of the D69 case: two Podman works, two incidents. */
const WSL = {
  id: "w-wsl",
  name: "Podman inside WSL",
  tickets: ["PAY-37"],
  now: "Waiting on the ServiceNow incident INC6650012 for the WSL kernel update",
  current: false,
  waits: ["ServiceNow incident INC6650012 (WSL kernel update)"],
};
const PODMAN_THREAD: NoteTriageThread = {
  id: "t-podman",
  date: "2026-10-30",
  summary:
    "Create a Story for the Podman 6.0.2 install failure linked to ServiceNow incident INC6779508",
  tickets: ["PAY-41"],
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
  {
    // A line about an earlier conversation's topic continues it; new work starts
    // a new one; a progress remark stays context (D66).
    name: "threads: one block continues the cert thread",
    items: [LEDGER, ONCALL],
    threads: [CERT_THREAD, QODER_THREAD],
    blocks: [
      {
        text: "Sarah says the gateway cert slips again, Platform now promises next Tuesday",
        expect: "act",
        thread: "t-cert",
      },
      {
        text: "- [ ] ask Dana to book the room for the Q4 planning offsite",
        expect: "act",
      },
      {
        text: "ledger export: staging run finished, every credit note matches",
        expect: "context",
        item: "w-ledger",
      },
    ],
  },
  {
    // Related work is not the same conversation (FR-20.8, D69): the WSL line shares
    // "podman" and "incident" with the Podman 6.0.2 thread but is about another
    // incident, so it starts its own; a line about that thread's incident continues it.
    name: "threads: related work with another incident starts its own",
    items: [WSL, LEDGER],
    threads: [PODMAN_THREAD, CERT_THREAD],
    blocks: [
      {
        text: "I'm testing new WSL version v3 for podman, it works, notify owner that incident can be closed",
        expect: "act",
      },
      {
        text: "the 6.0.2 install fix is in, that incident can be closed",
        expect: "act",
        thread: "t-podman",
      },
      {
        text: "WSL v3 testing: podman machine starts fine, volume mounts still to check",
        expect: "context",
        item: "w-wsl",
      },
    ],
  },
];

export const noteEvalInput = (c: NoteEvalCase): NoteTriageInput => ({
  blocks: c.blocks.map((b) => ({ text: b.text, section: b.section ?? null, date: TODAY })),
  items: c.items,
  ...(c.threads ? { threads: c.threads } : {}),
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
    if (d.kind === "act" && d.threadId !== (b.thread ?? null))
      return [`${label}: thread ${d.threadId ?? "none"}, expected ${b.thread ?? "none"}`];
    return [];
  });
}

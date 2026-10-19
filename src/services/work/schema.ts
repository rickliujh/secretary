/**
 * The work model's shapes (FR-19, D61): a work item's state, the event kinds,
 * the data events carry, grouping corrections and the work questions.
 *
 * The state holds only what the secretary believes; waits, blockers, dates and
 * the tickets' Jira fields are read from their tables when shown or sent to a
 * prompt, never copied in here.
 */
import { z } from "zod";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { RULE_NAMES } from "@/services/settings/schema";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ---------------------------------------------------------------------------
// State (D61)
// ---------------------------------------------------------------------------

export const CommitmentSchema = z
  .object({
    /** What the user promised, in a few words. */
    what: z.string().trim().min(1),
    /** A listed contact the promise was made to. */
    toPersonId: z.string().min(1).nullable().default(null),
    /** Who it was made to, as the event named them, when they are no contact. */
    toName: z.string().trim().min(1).nullable().default(null),
    dueOn: IsoDate.nullable().default(null),
    /** The event it was said in. */
    saidIn: z.string().min(1),
    status: z.enum(["open", "kept", "stale"]).default("open"),
  })
  .refine((c) => !!c.toPersonId || !!c.toName, {
    message: "A commitment is made to someone: a contact or a name",
  });
export type Commitment = z.infer<typeof CommitmentSchema>;

export const PersonRoleSchema = z
  .object({
    personId: z.string().min(1).nullable().default(null),
    name: z.string().trim().min(1).nullable().default(null),
    /** "asked for it", "owns the cert", "reviewer". */
    role: z.string().trim().min(1),
  })
  .refine((p) => !!p.personId || !!p.name, { message: "A person is a contact or a name" });
export type PersonRole = z.infer<typeof PersonRoleSchema>;

export const WorkStateSchema = z.object({
  goal: z.string().trim().default(""),
  currentStep: z.string().trim().default(""),
  nextExpected: z
    .object({ what: z.string().trim().min(1), on: IsoDate.nullable().default(null) })
    .nullable()
    .default(null),
  commitments: z.array(CommitmentSchema).default([]),
  openQuestions: z.array(z.string().trim().min(1)).default([]),
  people: z.array(PersonRoleSchema).default([]),
});
export type WorkState = z.infer<typeof WorkStateSchema>;

export const EMPTY_STATE: WorkState = WorkStateSchema.parse({});

/** A stored state, or null when it is missing or no longer parses. */
export function parseState(value: unknown): WorkState | null {
  if (value === null || value === undefined) return null;
  const r = WorkStateSchema.safeParse(value);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------
// Events (FR-19.2)
// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  /** One intake item or its revision (Inbox or chat), with the quote. */
  "message",
  "proposal_executed",
  "proposal_failed",
  "proposal_revoked",
  /** A field changed in Jira, seen at sync: status, assignee, due date, sprint, points, summary, links, resolution. */
  "jira_change",
  /** A new comment seen at sync. */
  "jira_comment",
  "draft_sent",
  "wait_opened",
  "wait_chased",
  "wait_rescheduled",
  "wait_resolved",
  /** The user stopped waiting: no longer needed, with their reason. */
  "wait_dropped",
  /** The user opened the ticket in the app; recorded, never folded into the state. */
  "ticket_viewed",
  /** The user changed the ticket from the app (a field, a status, a comment). */
  "ticket_edited",
  /** A note from the user ("I'm on the cert now"). */
  "note",
  /** The user's answer to a question the state update asked. */
  "answer",
  /** The user renamed, split or merged the item or moved a ticket; on the timeline only. */
  "correction",
  /** A consequence rule offered an outcome card (Phase 25); on the timeline only. */
  "outcome_offered",
  /** The user dismissed an outcome card; two on one item quiet its rule there. */
  "outcome_dismissed",
  /** The user asked a quiet rule to offer cards on the item again ("Ask again about ..."). */
  "rule_resumed",
  /** The user parked an Inbox thread about this item while on another (D62); timeline only. */
  "parked",
  /** A parked thread came back: the current item changed or closed, a new day, or the user. */
  "unparked",
  /** The end-of-day pass listed the item (D63); timeline only. */
  "day_end",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Kinds the state update never reads: they are recorded for the timeline only. */
export const TIMELINE_ONLY: ReadonlySet<EventKind> = new Set([
  "ticket_viewed",
  "correction",
  "outcome_offered",
  "outcome_dismissed",
  "rule_resumed",
  "parked",
  "unparked",
  "day_end",
]);

/** Kinds that carry words someone wrote, so a commitment may come from them. */
export const TEXT_KINDS: ReadonlySet<EventKind> = new Set([
  "message",
  "jira_comment",
  "note",
  "answer",
  "draft_sent",
]);

/**
 * Who did it: the user, a contact, a Jira user that is no contact, the sync, or
 * someone unknown (a paste with no sender, a change whose author Jira does not say).
 * `secretary`: the app itself (an outcome card offered, Phase 25).
 */
export type Actor =
  | "me"
  | "sync"
  | "unknown"
  | "secretary"
  | `contact:${string}`
  | `jira:${string}`;

/** What a message event (one intake item) carries for attachment and the state update. */
export const MessageDataSchema = z.object({
  inboxItemId: z.string(),
  intakeItemId: z.string(),
  /** The input, untrusted unless `ownWords`. */
  quote: z.string(),
  /** The user's typed instruction for it, if any (trusted). */
  instruction: z.string().nullable().default(null),
  /** Ticket keys the quote and instruction name. */
  keys: z.array(z.string()).default([]),
  /** Contacts the quote names, and the sender. */
  contactIds: z.array(z.string()).default([]),
  senderPersonId: z.string().nullable().default(null),
  source: z.string().default("other"),
  /** The user's own typed words, not a paste. */
  ownWords: z.boolean().default(false),
  /** The chat wrote it for the user (propose_actions): their request, by "me", not their words. */
  byChat: z.boolean().default(false),
  revision: z.boolean().default(false),
});
export type MessageData = z.infer<typeof MessageDataSchema>;

/** The data of any event, loosely: each kind reads what it needs. */
export const EventDataSchema = z
  .object({
    /** The words of the event (a quote, a comment body, a note). */
    text: z.string().optional(),
    keys: z.array(z.string()).optional(),
    contactIds: z.array(z.string()).optional(),
    dependencyId: z.string().optional(),
    inboxItemId: z.string().optional(),
    field: z.string().optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    /** The candidates a question offered, for the timeline. */
    candidates: z.array(z.string()).optional(),
  })
  .loose();
export type EventData = z.infer<typeof EventDataSchema>;

export const eventData = (value: unknown): EventData => {
  const r = EventDataSchema.safeParse(value ?? {});
  return r.success ? r.data : {};
};

/** The words of an event, for attachment, dates and the prompt. */
export function eventText(e: { kind: string; summary: string; data: unknown }): string {
  const d = eventData(e.data);
  const m = e.kind === "message" ? MessageDataSchema.safeParse(e.data) : null;
  if (m?.success) return [m.data.quote, m.data.instruction].filter(Boolean).join("\n");
  return d.text ?? "";
}

// ---------------------------------------------------------------------------
// Corrections (memories of kind example, subject `work_item`)
// ---------------------------------------------------------------------------

export const CorrectionSchema = z.discriminatedUnion("type", [
  /** These tickets are one piece of work (a merge, an answer). */
  z.object({ type: z.literal("together"), keys: z.array(z.string()).min(2) }),
  /** These two sets of tickets are separate work (a split, a move, an answer). */
  z.object({
    type: z.literal("apart"),
    keys: z.array(z.string()).min(1),
    from: z.array(z.string()).min(1),
  }),
  z.object({ type: z.literal("rename"), name: z.string() }),
  z.object({ type: z.literal("note"), note: z.string(), before: z.string() }),
  /** A step the user left out of an outcome card (Phase 25); `before` holds its payload. */
  z.object({ type: z.literal("step_left_out"), rule: z.string(), kind: z.string() }),
]);
export type Correction = z.infer<typeof CorrectionSchema>;

// ---------------------------------------------------------------------------
// Situations and outcome cards (FR-19.6, Phase 25)
// ---------------------------------------------------------------------------

export const RuleNameSchema = z.enum(RULE_NAMES);
export type { RuleName } from "@/services/settings/schema";

/**
 * Playbooks that are no consequence rule (FR-19.7, Phase 26): "waiting on
 * someone" expands a new wait, "wait resolved" a resolved one. They have no
 * rule switch; the standing instructions shape their steps.
 */
export const PLAYBOOK_NAMES = ["waiting_on_someone", "wait_resolved"] as const;
export type PlaybookName = (typeof PLAYBOOK_NAMES)[number];

/** What made a card or bundle: a consequence rule or a playbook. */
export const SITUATION_KINDS = [...RULE_NAMES, ...PLAYBOOK_NAMES] as const;
export const SituationKindSchema = z.enum(SITUATION_KINDS);
export type SituationKind = (typeof SITUATION_KINDS)[number];

/**
 * The live search for the owner's ticket (Phase 26, "waiting on someone"):
 * where it looked, what it found (stored out of scope, D45), and what code
 * picked by itself (a single clear match) or null.
 */
export const FoundSchema = z.object({
  /** The projects searched; empty when the owner has none, so no search ran. */
  projects: z.array(z.string()).default([]),
  /** "Could not search PLAT" when the search failed or timed out; the link step is skipped. */
  error: z.string().nullable().default(null),
  results: z
    .array(
      z.object({
        key: z.string(),
        summary: z.string(),
        status: z.string().nullable().default(null),
        url: z.string().nullable().default(null),
        /** Label stems its summary shares. */
        score: z.number().int().default(0),
      }),
    )
    .default([]),
  picked: z.string().nullable().default(null),
});
export type Found = z.infer<typeof FoundSchema>;

/**
 * One step of an outcome: a canonical proposal payload (so validation, editing,
 * revoke and the Executor need nothing new), its line on the card, and whether
 * the other steps hang on it (leaving it out drops them; its failure stops them).
 */
export const StepDraftSchema = z.object({
  payload: ProposalPayloadSchema,
  label: z.string().trim().min(1),
  required: z.boolean().default(false),
  /**
   * Runs only when the user picks one of the found tickets (Phase 26: the
   * `link_issues` to their ticket); left out with no correction otherwise.
   */
  choice: z.boolean().default(false),
});
/** A step as rules and playbooks write it: `choice` may be left out (false). */
export type StepDraft = Omit<z.infer<typeof StepDraftSchema>, "choice"> & { choice?: boolean };

/**
 * What a rule found (D61): `key` is `<rule>:<work_item_id>:<fingerprint>` of
 * the facts it used, so the same situation is offered once. `keys` are the
 * tickets it is about (Today hides their plain rows while the card is open).
 */
export const SituationSchema = z.object({
  rule: SituationKindSchema,
  key: z.string().min(1),
  title: z.string().trim().min(1),
  /** The facts in one line. */
  why: z.string().trim().min(1),
  keys: z.array(z.string()).default([]),
  /** The waits (dependency ids) it is about: Today hides only these wait rows. */
  waits: z.array(z.string()).default([]),
  /** The Jira comment ids it is about (`teammate_touched`): Today hides their comment rows. */
  comments: z.array(z.string()).default([]),
  /** The facts the rule used, as it read them. */
  facts: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(StepDraftSchema).default([]),
  /** A playbook's live search for the owner's ticket (Phase 26). */
  found: FoundSchema.nullable().default(null),
});
/** A situation as rules write it: `found` may be left out (null). */
export type Situation = Omit<z.infer<typeof SituationSchema>, "found" | "steps"> & {
  steps: StepDraft[];
  found?: Found | null;
};

/** An outcome card's `inbox_items.triage`: the situation without the payloads (they are the proposals). */
export const SituationRecordSchema = z.object({
  situation: z.object({
    rule: SituationKindSchema,
    key: z.string(),
    title: z.string(),
    why: z.string(),
    keys: z.array(z.string()).default([]),
    waits: z.array(z.string()).default([]),
    comments: z.array(z.string()).default([]),
    facts: z.record(z.string(), z.unknown()).default({}),
    itemName: z.string().default(""),
    /** One per proposal, by its `seq`. */
    steps: z
      .array(
        z.object({
          seq: z.number().int(),
          label: z.string(),
          required: z.boolean(),
          choice: z.boolean().default(false),
        }),
      )
      .default([]),
    found: FoundSchema.nullable().default(null),
    /**
     * A playbook bundle in a thread (Phase 26): the proposal it expanded, as
     * the model made it, for classify's corrections and the thread's revisions.
     */
    origin: z.unknown().nullable().default(null),
  }),
});
/** `origin` may be left out (null): only a playbook bundle in a thread has one. */
export type SituationRecord = Omit<z.infer<typeof SituationRecordSchema>["situation"], "origin"> & {
  origin?: unknown;
};

/** The situation record of an inbox item's triage, or null when it holds none. */
export function situationOf(triage: unknown): SituationRecord | null {
  const r = SituationRecordSchema.safeParse(triage);
  return r.success ? r.data.situation : null;
}

/** A playbook bundle's record as `bundles.record` stores it (Phase 26), or null. */
export function bundleRecordOf(record: unknown): SituationRecord | null {
  return situationOf({ situation: record });
}

export * from "./questions-schema";

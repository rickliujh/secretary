/**
 * The daily note (FR-20, D65): one free-form note per local day that the
 * secretary reads block by block. With an Obsidian vault chosen, the vault's
 * own daily note is the file of record (`sync.ts`); the reading (`read.ts`)
 * sends only new blocks, never private ones, to one `note_triage` call, and
 * turns them into Inbox threads, work item notes, or nothing. Nothing here
 * calls `JiraClient`: every Jira write is still a proposal.
 */
import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { IntakeError } from "@/services/intake";
import type { LlmError } from "@/services/llm";

export class NoteError extends Data.TaggedError("NoteError")<{
  /**
   * read_only: an earlier day. unavailable: the vault's note could not be
   * read or written (the message says why). not_running: Obsidian is not
   * running and the caller asked not to start it. not_found: Ask named a
   * block that is no longer in the note. private: Ask named a private block,
   * which is never sent (D67).
   */
  readonly kind: "read_only" | "unavailable" | "not_running" | "not_found" | "private";
  readonly message: string;
}> {}

/** The vault's daily note for today, as the Rust command read it. */
export type NoteFileRead = { path: string; text: string | null };
export type NoteFileWrite = {
  path: string;
  /** The file no longer held the expected text; nothing was written. */
  conflict: boolean;
  /** On a conflict, the file's current text (null: it does not exist). */
  text: string | null;
};

/** An image saved into the note's attachments (D70): its file and the link to insert. */
export type NoteImageSaved = { path: string; link: string };
/** An image's bytes as base64 and its type, e.g. "image/png" (D70). */
export type NoteImageLoaded = { mime: string; data: string };

/**
 * The vault's daily note file (D65). Live: the `daily_note_read` and
 * `daily_note_write` Tauri commands, which find the note through the
 * read-only Obsidian CLI and write it with compare-and-swap. Test: a fake.
 */
export interface NoteFileShape {
  /**
   * `launch`: start Obsidian when it is not running. Without it a closed
   * Obsidian fails with `not_running` and nothing is started.
   */
  readonly read: (vault: string, launch: boolean) => Effect.Effect<NoteFileRead, NoteError>;
  /** Writes when the file holds `expected` (null: it must not exist). */
  readonly write: (
    vault: string,
    text: string,
    expected: string | null,
    launch: boolean,
  ) => Effect.Effect<NoteFileWrite, NoteError>;
  /**
   * Saves a pasted or dropped image (D70): with a vault (its name) where
   * Obsidian would put it, by the vault's settings, starting a closed
   * Obsidian for the lookups; without one (null) in the app's data folder.
   * Returns the file's path and the link text to insert.
   */
  readonly saveImage: (
    vault: string | null,
    data: Uint8Array,
    ext: string,
  ) => Effect.Effect<NoteImageSaved, NoteError>;
  /**
   * The image a link names (its target, decoded), as base64 with its type;
   * null when it is not found. Never starts Obsidian: a closed one fails
   * with `not_running`.
   */
  readonly loadImage: (
    vault: string | null,
    link: string,
  ) => Effect.Effect<NoteImageLoaded | null, NoteError>;
}
export class NoteFile extends Context.Tag("NoteFile")<NoteFile, NoteFileShape>() {}

export type SyncStatus =
  | { state: "off" }
  | {
      state: "synced";
      /** The data source's name, as Settings shows it. */
      vault: string;
      path: string;
      at: string;
      /** Both sides changed the same lines: both were kept, the file's first. */
      conflict: boolean;
      /** The page's text changed through the merge. */
      changed: boolean;
    }
  | { state: "error"; vault: string; message: string }
  /** Obsidian is closed and this sync was not allowed to start it. */
  | { state: "not_running"; vault: string };

export type DayNote = {
  date: string;
  body: string;
  updatedAt: string | null;
  /** Today only; earlier days are read-only. */
  editable: boolean;
  syncedAt: string | null;
};

export type ReadTrigger = "pass" | "typing" | "button" | "chat";

/** What one reading did, for the page's line and the chat. */
export type ReadResult = {
  at: string;
  trigger: ReadTrigger;
  /** Off in Settings: nothing was read. */
  skipped?: "disabled";
  /** New Inbox threads. */
  cards: number;
  /** Threads revised because their block changed (D66: decided or not). */
  revised: number;
  /** Blocks that continued an earlier note thread as a new message there (D66). */
  continued: number;
  /** Ticked boxes that proposed closing their ticket. */
  closed: number;
  /** Work items a block was noted on, by name. */
  notes: string[];
  /** Blocks left alone. */
  skippedBlocks: number;
  /** New private blocks, never sent. */
  privateBlocks: number;
  /** New blocks over the cap, for the next read. */
  left: number;
  /** Whether the model was asked. */
  called: boolean;
  /** Why the reading stopped short, when it did. */
  error: string | null;
};

export interface DailyNoteShape {
  /** A day's note; an empty one when nothing was written that day. */
  readonly load: (date: string) => Effect.Effect<DayNote, DbError>;
  /**
   * Saves today's note as typed; no model call. Earlier days are read-only.
   * With `expected`, the body the page last loaded: when the stored body has
   * changed since (a sync, the chat), the page's edits are merged onto it and
   * the result is saved and returned for the page to show.
   */
  readonly save: (
    date: string,
    body: string,
    expected?: string,
  ) => Effect.Effect<DayNote, NoteError | DbError>;
  /** Adds a line at the end of today's note (the chat's "note this"). */
  readonly append: (line: string) => Effect.Effect<DayNote, NoteError | DbError>;
  /** Merges today's note with the vault's file of record, when one is chosen. */
  readonly sync: (opts?: { launch?: boolean }) => Effect.Effect<SyncStatus, DbError>;
  /**
   * Reads what is new in today's and yesterday's note (FR-20.3), after a sync
   * that starts Obsidian only for Read now (`button`).
   */
  readonly read: (trigger: ReadTrigger) => Effect.Effect<ReadResult, DbError>;
  /** What the last reading did, if any. */
  readonly lastRead: Effect.Effect<ReadResult | null, DbError>;
  /**
   * "Ask the secretary about this" (D67): a conversation on the block of that
   * day's stored note with this hash, routed as the reading routes a new block
   * (D66); the block is recorded acted. Takes turns with the readings.
   */
  readonly ask: (
    date: string,
    hash: string,
  ) => Effect.Effect<{ inboxItemId: string }, NoteError | IntakeError | LlmError | DbError>;
}
export class DailyNote extends Context.Tag("DailyNote")<DailyNote, DailyNoteShape>() {}

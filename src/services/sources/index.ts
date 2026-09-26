/**
 * Data sources (design.md D41): folders of notes outside Jira, Obsidian vaults
 * first, indexed locally so the chat can search and read them. Files are read
 * directly; Obsidian does not need to run.
 */
import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";

export class SourceError extends Data.TaggedError("SourceError")<{
  /**
   * not_found: no such source or document. no_access: the folder cannot be read
   * (moved, deleted, or permission not granted; pick it again in Settings).
   */
  readonly kind: "not_found" | "no_access";
  readonly message: string;
}> {}

/** A file in a source folder, as listed by `VaultFs`. */
export type VaultFile = {
  /** Path inside the folder with forward slashes, e.g. "Projects/Ledger.md". */
  path: string;
  /** Modification time in ms since the epoch. */
  mtime: number;
  size: number;
};

/**
 * File access for sources. Live: the Tauri fs plugin, within the folders the
 * user picked (the pick grants access, persisted across restarts). Test: memory.
 */
export interface VaultFsShape {
  /** Every Markdown file under `root`, recursively, skipping dot folders. */
  readonly list: (root: string) => Effect.Effect<VaultFile[], SourceError>;
  readonly readText: (root: string, path: string) => Effect.Effect<string, SourceError>;
}
export class VaultFs extends Context.Tag("VaultFs")<VaultFs, VaultFsShape>() {}

export type IndexResult = {
  sourceId: string;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Files left out: too large or unreadable. */
  skipped: number;
  durationMs: number;
};

export type SourceStatus = {
  sourceId: string;
  documents: number;
  lastIndexedAt: string | null;
  lastError: string | null;
};

export type SearchHit = {
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  tags: string[];
  /** A short excerpt around the match, from the note's text. */
  snippet: string;
  /** ISO time of the file's last change. */
  modified: string;
};

export type SourceDocument = {
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  frontmatter: Record<string, unknown> | null;
  /** Markdown without the frontmatter. */
  body: string;
  /** Notes this one links to, and notes linking here (titles or paths). */
  links: string[];
  backlinks: string[];
  modified: string;
};

export interface SourcesShape {
  /**
   * Brings the index up to date with the enabled sources (or one): new and
   * changed files are parsed, deleted or excluded ones removed, unchanged ones
   * skipped by modification time and size. Removed sources lose their rows.
   */
  readonly index: (opts?: {
    sourceId?: string;
    force?: boolean;
  }) => Effect.Effect<IndexResult[], SourceError | DbError>;
  /** `index` when the last run is older than `maxAgeMs`; failures are recorded, not raised. */
  readonly indexIfStale: (maxAgeMs: number) => Effect.Effect<void>;
  /** Full-text search over enabled sources, best first. */
  readonly search: (
    query: string,
    opts?: { limit?: number; sourceId?: string },
  ) => Effect.Effect<SearchHit[], DbError>;
  /**
   * One document by path, or by title or alias when `path` is not found (so a
   * wikilink target works).
   */
  readonly read: (
    sourceId: string,
    path: string,
  ) => Effect.Effect<SourceDocument, SourceError | DbError>;
  readonly status: Effect.Effect<SourceStatus[], DbError>;
}
export class Sources extends Context.Tag("Sources")<Sources, SourcesShape>() {}

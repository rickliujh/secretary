/**
 * Data sources (design.md D41): the user's notes outside Jira, Obsidian vaults
 * first. Obsidian does the work through its CLI (Obsidian 1.12.7+, enabled in
 * Settings > General > Advanced > Command line interface): Secretary runs one
 * short-lived `obsidian` command per lookup and ranks search results itself.
 * Nothing is indexed or kept; Obsidian opens if it is not running.
 */
import { Context, Data, type Effect } from "effect";

export class SourceError extends Data.TaggedError("SourceError")<{
  /**
   * not_found: no such source, vault or note. unavailable: the Obsidian CLI is
   * missing, turned off, or did not answer (see `message` for what to do).
   */
  readonly kind: "not_found" | "unavailable";
  readonly message: string;
}> {}

/** Raw result of one `obsidian` command. */
export type CliOutput = { stdout: string; code: number | null };

/**
 * Runs the `obsidian` command. Live: a Tauri command that only allows read-only
 * subcommands and finds the binary (or uses the path set in Settings). Test: a
 * fake over an in-memory vault.
 */
export interface ObsidianCliShape {
  /** `args` as the CLI takes them, e.g. ["vault=Work", "search:context", "query=ledger", "format=json"]. */
  readonly run: (args: readonly string[]) => Effect.Effect<CliOutput, SourceError>;
}
export class ObsidianCli extends Context.Tag("ObsidianCli")<ObsidianCli, ObsidianCliShape>() {}

export type SearchHit = {
  sourceId: string;
  sourceName: string;
  /** Path in the vault, e.g. "Projects/Ledger export.md". */
  path: string;
  /** File name without ".md". */
  title: string;
  /** The matching lines, joined and clipped. */
  snippet: string;
  /** How many lines matched. */
  matches: number;
};

export type SourceDocument = {
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  /** YAML frontmatter as parsed, or null. */
  properties: Record<string, unknown> | null;
  /** Markdown without the frontmatter. */
  body: string;
  tags: string[];
  /** Paths of notes linking here. */
  backlinks: string[];
};

export type SourceCheck =
  | { ok: true; notes: number }
  | { ok: false; kind: SourceError["kind"]; message: string };

export interface SourcesShape {
  /** Searches the enabled sources (or one), best first. */
  readonly search: (
    query: string,
    opts?: { limit?: number; sourceId?: string },
  ) => Effect.Effect<SearchHit[], SourceError>;
  /** One note by vault path, or by name the way a [[link]] resolves. */
  readonly read: (sourceId: string, path: string) => Effect.Effect<SourceDocument, SourceError>;
  /** Vault names Obsidian knows, most recently opened first. */
  readonly vaults: Effect.Effect<string[], SourceError>;
  /** Whether the CLI answers for a source's vault, and how many files it has. */
  readonly check: (sourceId: string) => Effect.Effect<SourceCheck>;
}
export class Sources extends Context.Tag("Sources")<Sources, SourcesShape>() {}

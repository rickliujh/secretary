/**
 * `Sources` over the Obsidian CLI (design.md D41): one short-lived `obsidian`
 * command per lookup; Obsidian searches and resolves notes, code ranks.
 */
import { Effect, Layer } from "effect";
import { Settings, settingsOrDefault } from "@/services/settings";
import type { DataSource } from "@/services/settings/schema";
import {
  type CliOutput,
  ObsidianCli,
  type SearchHit,
  type SourceCheck,
  type SourceDocument,
  SourceError,
  Sources,
} from ".";
import {
  type CliSearchResult,
  cliError,
  parseCount,
  parseFilePath,
  parseLines,
  parseSearch,
  parseTable,
  splitFrontmatter,
} from "./cli-output";
import { noteName, queryWords, rankResults, searchQueries } from "./rank";

const DEFAULT_LIMIT = 8;

const notFound = (message: string) => new SourceError({ kind: "not_found", message });

/** Output parsers throw SourceError; this turns them into typed failures. */
const parse = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (e) =>
      e instanceof SourceError ? e : new SourceError({ kind: "unavailable", message: String(e) }),
  });

const make = Effect.gen(function* () {
  const cli = yield* ObsidianCli;
  const settingsSvc = yield* Settings;

  const enabledSources = (sourceId?: string) =>
    Effect.map(settingsOrDefault(settingsSvc), (s) =>
      s.dataSources.filter((d) => d.enabled && (sourceId === undefined || d.id === sourceId)),
    );

  const source = (sourceId: string) =>
    Effect.flatMap(enabledSources(sourceId), ([s]) =>
      s ? Effect.succeed(s) : Effect.fail(notFound(`No enabled vault "${sourceId}".`)),
    );

  /** One command in the source's vault; error text becomes a SourceError. */
  const run = (s: DataSource | null, args: readonly string[]) =>
    Effect.flatMap(cli.run(s ? [`vault=${s.vault}`, ...args] : args), (out: CliOutput) => {
      const error = cliError(out.stdout, out.code);
      return error ? Effect.fail(error) : Effect.succeed(out.stdout);
    });

  const searchQuery = (s: DataSource, query: string) =>
    Effect.flatMap(run(s, ["search:context", `query=${query}`, "format=json"]), (out) =>
      parse(() => parseSearch(out)),
    );

  const searchOne = (s: DataSource, words: string[], limit: number) =>
    Effect.gen(function* () {
      const q = searchQueries(words);
      if (!q) return [];
      const passes: CliSearchResult[][] = [yield* searchQuery(s, q.all)];
      // Too few notes with every word: widen to any of them.
      if (q.any && (passes[0]?.length ?? 0) < limit) passes.push(yield* searchQuery(s, q.any));
      return rankResults(words, passes).map(
        (r): SearchHit => ({
          sourceId: s.id,
          sourceName: s.name,
          path: r.path,
          title: r.title,
          snippet: r.snippet,
          matches: r.matches,
        }),
      );
    });

  const search = (text: string, opts?: { limit?: number; sourceId?: string }) =>
    Effect.gen(function* () {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      const sources = yield* enabledSources(opts?.sourceId);
      const words = queryWords(text);
      if (!sources.length || !words.length || limit <= 0) return [];
      const perSource = yield* Effect.forEach(sources, (s) => searchOne(s, words, limit), {
        concurrency: 3,
      });
      // Each vault is ranked already; interleave so one vault does not crowd out another.
      const out: SearchHit[] = [];
      for (let i = 0; out.length < limit; i++) {
        const round = perSource.flatMap((hits) => (hits[i] ? [hits[i]] : []));
        if (!round.length) break;
        out.push(...round.slice(0, limit - out.length));
      }
      return out;
    });

  const read = (sourceId: string, target: string) =>
    Effect.gen(function* () {
      const s = yield* source(sourceId);
      const name =
        target
          .replace(/^\[\[|\]\]$/g, "")
          .split(/[|#]/)[0]
          ?.trim() ?? "";
      if (!name) return yield* Effect.fail(notFound("Which note? Give its path or name."));
      // A vault path is read as is; anything else resolves the way a [[link]] does.
      const path = /\.md$/i.test(name)
        ? name
        : parseFilePath(yield* run(s, ["file", `file=${name}`]));
      if (!path) return yield* Effect.fail(notFound(`No note "${name}" in ${s.name}.`));
      const at = `path=${path}`;
      const [text, backlinks, tags] = yield* Effect.all(
        [
          run(s, ["read", at]),
          run(s, ["backlinks", at, "format=json"]).pipe(
            Effect.flatMap((out) => parse(() => parseTable(out, "file"))),
            Effect.orElseSucceed((): string[] => []),
          ),
          run(s, ["tags", at, "format=json"]).pipe(
            Effect.flatMap((out) => parse(() => parseTable(out, "tag"))),
            Effect.orElseSucceed((): string[] => []),
          ),
        ],
        { concurrency: 3 },
      );
      const { frontmatter, body } = splitFrontmatter(text);
      return {
        sourceId: s.id,
        sourceName: s.name,
        path,
        title: noteName(path),
        properties: frontmatter,
        body,
        tags: tags.map((t) => t.replace(/^#/, "")),
        backlinks,
      } satisfies SourceDocument;
    });

  const vaults = Effect.flatMap(run(null, ["vaults"]), (out) => parse(() => parseLines(out)));

  const check = (sourceId: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      const s = settings.dataSources.find((d) => d.id === sourceId);
      if (!s) return yield* Effect.fail(notFound(`No vault "${sourceId}".`));
      const notes = parseCount(yield* run(s, ["files", "ext=md", "total"]));
      if (notes === null)
        return yield* Effect.fail(
          new SourceError({ kind: "unavailable", message: "Obsidian gave no file count." }),
        );
      return { ok: true, notes } satisfies SourceCheck;
    }).pipe(
      Effect.catchAll((e) =>
        Effect.succeed({ ok: false, kind: e.kind, message: e.message } satisfies SourceCheck),
      ),
    );

  return Sources.of({ search, read, vaults, check });
});

export const SourcesLive = Layer.effect(Sources, make);

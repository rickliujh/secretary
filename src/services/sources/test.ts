/**
 * A fake `obsidian` command for tests (D41), over in-memory vaults, printing
 * what Obsidian 1.13's CLI handlers print; plus a loader for the fixture vault.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { ObsidianCli } from ".";
import { splitFrontmatter } from "./cli-output";

/** vault name -> path in the vault -> file text. */
export type MemoryVaults = Record<string, Record<string, string>>;

type Options = {
  /** Paths Obsidian's "Excluded files" setting hides from search. */
  excluded?: string[];
  /** Off: every command answers that the CLI is disabled. */
  enabled?: boolean;
};

const notes = (files: Record<string, string>, excluded: string[] = []) =>
  Object.keys(files).filter(
    (p) =>
      /\.md$/i.test(p) &&
      !p.split("/").some((s) => s.startsWith(".")) &&
      !excluded.some((e) => p === e || p.startsWith(`${e.replace(/\/$/, "")}/`)),
  );

const base = (p: string) => p.split("/").pop()?.replace(/\.md$/i, "").toLowerCase() ?? "";

/** Resolves a name the way a [[link]] does: full path without ".md", or file name. */
const resolve = (files: Record<string, string>, name: string) => {
  const n = name.toLowerCase().replace(/\.md$/i, "");
  const all = notes(files);
  return (
    all.find((p) => p.toLowerCase().replace(/\.md$/i, "") === n) ??
    all.find((p) => base(p) === n) ??
    null
  );
};

const linksOf = (text: string) =>
  [...text.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(
    (m) => m[1]?.trim() ?? "",
  );

const tagsOf = (text: string) => {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = frontmatter?.tags;
  const listed = Array.isArray(fm) ? fm : typeof fm === "string" ? fm.split(/[,\s]+/) : [];
  const inline = [
    ...body
      .replace(/```[\s\S]*?```/g, "")
      .matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu),
  ].map((m) => m[1] ?? "");
  return [...new Set([...listed.map(String), ...inline].map((t) => `#${t.replace(/^#/, "")}`))];
};

/** Obsidian's search: terms separated by spaces must all match; OR between groups. */
function search(files: Record<string, string>, query: string, excluded: string[]) {
  const groups = query
    .split(/\s+OR\s+/)
    .map((g) =>
      [...g.matchAll(/"([^"]*)"|(\S+)/g)]
        .map((m) => (m[1] ?? m[2] ?? "").toLowerCase())
        .filter(Boolean),
    );
  const out: { file: string; matches: { line: number; text: string }[] }[] = [];
  for (const path of notes(files, excluded)) {
    const text = files[path] ?? "";
    const hay = `${path}\n${text}`.toLowerCase();
    const group = groups.find((g) => g.every((t) => hay.includes(t)));
    if (!group) continue;
    // Like Obsidian, a line is listed once for every term it contains.
    const matches = text
      .split("\n")
      .flatMap((l, i) =>
        group
          .filter((t) => l.toLowerCase().includes(t))
          .map(() => ({ line: i + 1, text: l.trim() })),
      );
    out.push({ file: path, matches });
  }
  return out;
}

export function makeObsidianCliTest(initial: MemoryVaults = {}, opts: Options = {}) {
  const vaults: MemoryVaults = structuredClone(initial);
  const calls: string[][] = [];
  const answer = (args: readonly string[]): string => {
    if (opts.enabled === false)
      return "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.";
    let rest = [...args];
    let files: Record<string, string> | undefined;
    if (rest[0]?.startsWith("vault=")) {
      files = vaults[rest[0].slice(6)];
      if (!files) return "Vault not found.";
      rest = rest.slice(1);
    }
    const [command, ...params] = rest;
    const p = Object.fromEntries(
      params.map((a) =>
        a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, "true"],
      ),
    );
    if (command === "vaults") return Object.keys(vaults).join("\n");
    if (!files) files = Object.values(vaults)[0] ?? {};
    const target = () => {
      const path = p.path
        ? files?.[p.path] !== undefined
          ? p.path
          : null
        : resolve(files ?? {}, p.file ?? "");
      if (!path) throw `File "${p.path ?? p.file}" not found.`;
      return path;
    };
    try {
      switch (command) {
        case "search:context": {
          const r = search(files, p.query ?? "", opts.excluded ?? []);
          return r.length ? JSON.stringify(r) : "No matches found.";
        }
        case "file": {
          const path = target();
          return `path\t${path}\nname\t${base(path)}\nextension\tmd\nsize\t${(files[path] ?? "").length}`;
        }
        case "read":
          return files[target()] ?? "";
        case "backlinks": {
          const path = target();
          const names = [path.toLowerCase().replace(/\.md$/i, ""), base(path)];
          const from = notes(files).filter(
            (f) =>
              f !== path && linksOf(files?.[f] ?? "").some((l) => names.includes(l.toLowerCase())),
          );
          return from.length
            ? JSON.stringify(
                from.sort().map((file) => ({ file })),
                null,
                2,
              )
            : "No backlinks found.";
        }
        case "tags": {
          const tags = tagsOf(files[target()] ?? "");
          return tags.length
            ? JSON.stringify(
                tags.map((tag) => ({ tag })),
                null,
                2,
              )
            : "No tags found.";
        }
        case "files":
          return String(notes(files).length);
        default:
          throw `Command "${command}" not found.`;
      }
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  };
  const layer = Layer.succeed(
    ObsidianCli,
    ObsidianCli.of({
      run: (args) =>
        Effect.sync(() => {
          calls.push([...args]);
          return { stdout: answer(args), code: 0 };
        }),
    }),
  );
  return { layer, vaults, calls };
}

/** Reads a folder on disk into memory files, dot folders included. */
export function loadVaultFromDisk(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(join(abs, e.name), path);
      else out[path] = readFileSync(join(abs, e.name), "utf8");
    }
  };
  visit(dir, "");
  return out;
}

export const FIXTURE_VAULT_DIR = join(import.meta.dir, "../../test/fixtures/vault");

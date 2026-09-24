/** JSON backup of teams, people and their notes (FR-4.6). Secrets are never part of it. */
import { Effect } from "effect";
import { z } from "zod";
import { contextNotes, people, teams } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ProfileSchema } from "./schema";

const TeamRow = z.object({
  id: z.string(),
  name: z.string(),
  function: z.string().nullable(),
  contactFor: z.string().nullable(),
  channel: z.string().nullable(),
  escalationPath: z.string().nullable(),
  confluenceUrls: z.array(z.string()),
  notesMd: z.string().nullable(),
});
const PersonRow = z.object({
  id: z.string(),
  displayName: z.string(),
  jiraUsername: z.string().nullable(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  teamId: z.string().nullable(),
  responsibilities: z.string().nullable(),
  profile: ProfileSchema,
  notesMd: z.string().nullable(),
});
const NoteRow = z.object({
  id: z.string(),
  subjectType: z.enum(["team", "person"]),
  subjectId: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  sourceUrl: z.string().nullable(),
  sourceVersion: z.number().nullable(),
  importedAt: z.string(),
});

export const DirectoryExportSchema = z.object({
  format: z.literal("secretary.directory"),
  version: z.literal(1),
  exportedAt: z.string(),
  teams: z.array(TeamRow),
  people: z.array(PersonRow),
  notes: z.array(NoteRow),
});
export type DirectoryExport = z.infer<typeof DirectoryExportSchema>;

export const exportDirectory = Effect.gen(function* () {
  const t = yield* query((db) => db.select().from(teams).all());
  const p = yield* query((db) => db.select().from(people).all());
  const n = (yield* query((db) => db.select().from(contextNotes).all())).filter(
    (x) => x.subjectType === "team" || x.subjectType === "person",
  );
  return DirectoryExportSchema.parse({
    format: "secretary.directory",
    version: 1,
    exportedAt: nowIso(),
    teams: t,
    people: p,
    notes: n,
  });
});

export type ImportSummary = { teams: number; people: number; notes: number };

/** Upserts by id, so importing the same file twice is harmless. Invalid files are rejected whole. */
export const importDirectory = (json: unknown) =>
  Effect.gen(function* () {
    const data = yield* Effect.try({
      try: () => DirectoryExportSchema.parse(json),
      catch: (e) =>
        new Error(
          e instanceof z.ZodError
            ? `Not a valid directory export: ${e.issues
                .slice(0, 3)
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")}`
            : String(e),
        ),
    });
    const teamIds = new Set(data.teams.map((t) => t.id));
    for (const t of data.teams) {
      yield* query((db) =>
        db.insert(teams).values(t).onConflictDoUpdate({ target: teams.id, set: t }),
      );
    }
    const existingTeams = new Set(
      (yield* query((db) => db.select({ id: teams.id }).from(teams).all())).map((r) => r.id),
    );
    for (const p of data.people) {
      // A team missing from both the file and the database would break the foreign key.
      const row = {
        ...p,
        teamId:
          p.teamId && (teamIds.has(p.teamId) || existingTeams.has(p.teamId)) ? p.teamId : null,
      };
      yield* query((db) =>
        db.insert(people).values(row).onConflictDoUpdate({ target: people.id, set: row }),
      );
    }
    for (const n of data.notes) {
      yield* query((db) =>
        db.insert(contextNotes).values(n).onConflictDoUpdate({ target: contextNotes.id, set: n }),
      );
    }
    return {
      teams: data.teams.length,
      people: data.people.length,
      notes: data.notes.length,
    } satisfies ImportSummary;
  });

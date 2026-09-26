/** Context notes: free notes and imported Confluence pages (FR-4.4, FR-4.5). */
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { contextNotes } from "@/db/schema";
import { storageToMarkdown } from "@/lib/confluence-md";
import { newId, nowIso } from "@/lib/ids";
import { ConfluenceClient } from "@/services/confluence";
import { webUrl } from "@/services/confluence/cql";
import { query } from "@/services/db";
import { type NoteInput, NoteInputSchema, type Subject } from "./schema";

export type ContextNote = typeof contextNotes.$inferSelect;

const forSubject = (s: Subject) =>
  and(eq(contextNotes.subjectType, s.type), eq(contextNotes.subjectId, s.id));

export const listNotes = (subject: Subject) =>
  query((db) =>
    db
      .select()
      .from(contextNotes)
      .where(forSubject(subject))
      .orderBy(desc(contextNotes.importedAt))
      .all(),
  );

export const addNote = (subject: Subject, input: NoteInput) =>
  Effect.gen(function* () {
    const v = NoteInputSchema.parse(input);
    const id = newId();
    yield* query((db) =>
      db.insert(contextNotes).values({
        id,
        subjectType: subject.type,
        subjectId: subject.id,
        title: v.title,
        bodyMd: v.bodyMd,
        importedAt: nowIso(),
      }),
    );
    return id;
  });

export const updateNote = (id: string, input: NoteInput) =>
  query((db) =>
    db.update(contextNotes).set(NoteInputSchema.parse(input)).where(eq(contextNotes.id, id)),
  );

export const deleteNote = (id: string) =>
  query((db) => db.delete(contextNotes).where(eq(contextNotes.id, id)));

export type ImportResult = { noteId: string; title: string; version: number; replaced: boolean };

/**
 * Imports a Confluence page as Markdown. Importing the same page onto the same
 * subject again replaces the note, which is how "check for update" works.
 */
export const importConfluencePage = (pageId: string, subject: Subject) =>
  Effect.gen(function* () {
    const confluence = yield* ConfluenceClient;
    const base = yield* confluence.baseUrl;
    const page = yield* confluence.getPage(pageId);
    const sourceUrl =
      webUrl(page._links, base) ?? `${base}/pages/viewpage.action?pageId=${page.id}`;
    const bodyMd = storageToMarkdown(page.body.storage.value, {
      baseUrl: page._links.base || base,
    });
    const existing = yield* query((db) =>
      db
        .select({ id: contextNotes.id })
        .from(contextNotes)
        .where(and(forSubject(subject), eq(contextNotes.sourceId, page.id)))
        .get(),
    );
    const values = {
      title: page.title,
      bodyMd,
      sourceUrl,
      sourceId: page.id,
      sourceVersion: page.version.number,
      importedAt: nowIso(),
    };
    if (existing) {
      yield* query((db) =>
        db.update(contextNotes).set(values).where(eq(contextNotes.id, existing.id)),
      );
      return {
        noteId: existing.id,
        title: page.title,
        version: page.version.number,
        replaced: true,
      } satisfies ImportResult;
    }
    const noteId = newId();
    yield* query((db) =>
      db
        .insert(contextNotes)
        .values({ id: noteId, subjectType: subject.type, subjectId: subject.id, ...values }),
    );
    return {
      noteId,
      title: page.title,
      version: page.version.number,
      replaced: false,
    } satisfies ImportResult;
  });

/** Note ids matching free text, via the FTS index (the chat tools search notes with it). */
export const searchNoteIds = (match: string) =>
  query((db) =>
    db
      .select({ id: contextNotes.id })
      .from(contextNotes)
      .where(
        sql`${contextNotes}.rowid IN (SELECT rowid FROM context_notes_fts WHERE context_notes_fts MATCH ${match})`,
      )
      .all(),
  );

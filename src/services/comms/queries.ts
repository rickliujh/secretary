/** Draft records for the Drafts page (design.md D24): direct local writes. */
import { and, desc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import { communications, dependencies, people, teams } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { logFollowup } from "@/services/dependencies/queries";
import { localDate } from "@/services/intake";
import {
  CommsError,
  type DraftEdit,
  DraftEditSchema,
  type DraftRequest,
  DraftRequestSchema,
} from ".";

const notFound = () =>
  new CommsError({ kind: "not_found", message: "That draft no longer exists." });

export const createDraft = (input: DraftRequest) =>
  Effect.gen(function* () {
    const v = DraftRequestSchema.parse(input);
    const id = newId();
    yield* query((d) =>
      d.insert(communications).values({
        id,
        kind: v.kind,
        intent: v.intent,
        recipientPersonId: v.recipientPersonId,
        // A person is the recipient; their team only gives context.
        recipientTeamId: v.recipientPersonId ? null : v.recipientTeamId,
        issueKeys: v.issueKeys,
        dependencyId: v.dependencyId,
        notesMd: v.notes,
        bodyMd: "",
        status: "draft",
        createdAt: nowIso(),
      }),
    );
    return id;
  });

export type DraftListItem = {
  id: string;
  kind: "teams" | "email";
  intent: string;
  status: "draft" | "copied" | "sent";
  recipient: string | null;
  preview: string;
  generated: boolean;
  createdAt: string;
  sentAt: string | null;
};

export const listDrafts = Effect.gen(function* () {
  const rows = yield* query((d) =>
    d
      .select({
        c: communications,
        person: people.displayName,
        team: teams.name,
      })
      .from(communications)
      .leftJoin(people, eq(people.id, communications.recipientPersonId))
      .leftJoin(teams, eq(teams.id, communications.recipientTeamId))
      .orderBy(desc(communications.createdAt))
      .limit(200)
      .all(),
  );
  return rows.map(
    ({ c, person, team }): DraftListItem => ({
      id: c.id,
      kind: c.kind,
      intent: c.intent,
      status: c.status,
      recipient: person ?? team ?? null,
      preview: (c.subject || c.bodyMd || c.notesMd || "").replace(/\s+/g, " ").slice(0, 120),
      generated: c.variants !== null,
      createdAt: c.createdAt,
      sentAt: c.sentAt,
    }),
  );
});

export const draftDetail = (id: string) =>
  Effect.gen(function* () {
    // Separate reads: whole-table joins collide on shared column names in the SQL proxy.
    const c = yield* query((d) =>
      d.select().from(communications).where(eq(communications.id, id)).get(),
    );
    if (!c) return null;
    const person = c.recipientPersonId
      ? ((yield* query((d) =>
          d
            .select()
            .from(people)
            .where(eq(people.id, c.recipientPersonId ?? ""))
            .get(),
        )) ?? null)
      : null;
    const team = c.recipientTeamId
      ? ((yield* query((d) =>
          d
            .select()
            .from(teams)
            .where(eq(teams.id, c.recipientTeamId ?? ""))
            .get(),
        )) ?? null)
      : null;
    const dependency = c.dependencyId
      ? ((yield* query((d) =>
          d
            .select({
              id: dependencies.id,
              label: dependencies.label,
              issueKey: dependencies.issueKey,
              externalRef: dependencies.externalRef,
            })
            .from(dependencies)
            .where(eq(dependencies.id, c.dependencyId ?? ""))
            .get(),
        )) ?? null)
      : null;
    // FR-6.5: earlier messages to the same recipient, for continuity.
    const toSame = c.recipientPersonId
      ? eq(communications.recipientPersonId, c.recipientPersonId)
      : eq(communications.recipientTeamId, c.recipientTeamId ?? "");
    const recent = yield* query((d) =>
      d
        .select()
        .from(communications)
        .where(and(toSame, eq(communications.status, "sent"), ne(communications.id, id)))
        .orderBy(desc(communications.sentAt))
        .limit(3)
        .all(),
    );
    return {
      draft: c,
      person,
      team,
      dependency,
      recent,
    };
  });

export type DraftDetail = NonNullable<Effect.Effect.Success<ReturnType<typeof draftDetail>>>;

export const saveDraft = (id: string, edit: DraftEdit) =>
  Effect.gen(function* () {
    const v = DraftEditSchema.parse(edit);
    const r = yield* query((d) =>
      d
        .update(communications)
        .set({ variant: v.variant, subject: v.subject, bodyMd: v.bodyMd })
        .where(eq(communications.id, id))
        .returning({ id: communications.id }),
    );
    if (r.length === 0) return yield* notFound();
  });

/** Copying counts as progress but not as sent; only "mark sent" logs a follow-up. */
export const markCopied = (id: string) =>
  query((d) =>
    d
      .update(communications)
      .set({ status: "copied" })
      .where(and(eq(communications.id, id), eq(communications.status, "draft"))),
  );

/** FR-6.3: a sent chase is a follow-up on its dependency (and schedules the next one). */
export const markSent = (id: string, today = localDate()) =>
  Effect.gen(function* () {
    const c = yield* query((d) =>
      d.select().from(communications).where(eq(communications.id, id)).get(),
    );
    if (!c) return yield* notFound();
    if (c.status === "sent") return;
    yield* query((d) =>
      d
        .update(communications)
        .set({ status: "sent", sentAt: nowIso() })
        .where(eq(communications.id, id)),
    );
    if (c.dependencyId) {
      const first = c.bodyMd.split("\n").find((l) => l.trim()) ?? "";
      yield* logFollowup(
        c.dependencyId,
        {
          channel: c.kind,
          summary: `Sent ${c.intent.replace("_", " ")}: ${c.subject || first}`.slice(0, 300),
          communicationId: id,
        },
        today,
      );
    }
  });

export const deleteDraft = (id: string) =>
  query((d) => d.delete(communications).where(eq(communications.id, id)));

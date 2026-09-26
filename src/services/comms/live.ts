import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  communications,
  dependencies,
  followups,
  jiraIssues,
  memories,
  people,
  teams,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
import {
  buildDraftPrompt,
  type DraftContext,
  type DraftOutput,
  DraftOutputSchema,
  validateDraft,
} from "@/prompts/draft";
import { Db, query } from "@/services/db";
import { Llm } from "@/services/llm";
import type { MESSAGE_INTENTS } from "@/services/proposals/schema";
import { Settings } from "@/services/settings";
import { Comms, CommsError } from ".";

const RECENT_MESSAGES = 3;
const MAX_MEMORIES = 10;

const make = Effect.gen(function* () {
  const db = yield* Db;
  const llm = yield* Llm;
  const settings = yield* Settings;
  const q = <A>(f: Parameters<typeof query<A>>[0]) => Effect.provideService(query(f), Db, db);

  /** Everything the model may use, gathered from local data (design.md D24). */
  const context = (
    row: typeof communications.$inferSelect,
    today: string,
    instructions: string[],
  ) =>
    Effect.gen(function* () {
      const person = row.recipientPersonId
        ? yield* q((d) =>
            d
              .select()
              .from(people)
              .where(eq(people.id, row.recipientPersonId ?? ""))
              .get(),
          )
        : undefined;
      const teamId = row.recipientTeamId ?? person?.teamId ?? null;
      const team = teamId
        ? yield* q((d) => d.select().from(teams).where(eq(teams.id, teamId)).get())
        : undefined;
      const issues = row.issueKeys.length
        ? yield* q((d) =>
            d.select().from(jiraIssues).where(inArray(jiraIssues.key, row.issueKeys)).all(),
          )
        : [];
      const dep = row.dependencyId
        ? yield* q((d) =>
            d
              .select()
              .from(dependencies)
              .where(eq(dependencies.id, row.dependencyId ?? ""))
              .get(),
          )
        : undefined;
      const chases = dep
        ? yield* q((d) =>
            d
              .select()
              .from(followups)
              .where(eq(followups.dependencyId, dep.id))
              .orderBy(followups.at)
              .all(),
          )
        : [];
      const toSame = row.recipientPersonId
        ? eq(communications.recipientPersonId, row.recipientPersonId)
        : eq(communications.recipientTeamId, row.recipientTeamId ?? "");
      const recent = yield* q((d) =>
        d
          .select()
          .from(communications)
          .where(and(toSame, eq(communications.status, "sent"), ne(communications.id, row.id)))
          .orderBy(desc(communications.sentAt))
          .limit(RECENT_MESSAGES)
          .all(),
      );
      const about = [
        ...(person
          ? [and(eq(memories.subjectType, "person"), eq(memories.subjectId, person.id))]
          : []),
        ...(row.recipientTeamId
          ? [and(eq(memories.subjectType, "team"), eq(memories.subjectId, row.recipientTeamId))]
          : []),
      ];
      const notes = about.length
        ? yield* q((d) =>
            d
              .select({ content: memories.content })
              .from(memories)
              .where(and(eq(memories.confirmed, true), ne(memories.kind, "example"), or(...about)))
              .limit(MAX_MEMORIES)
              .all(),
          )
        : [];
      const s = yield* settings.get.pipe(Effect.orElseSucceed(() => undefined));

      return {
        today,
        language: person?.profile.language || s?.general.outputLanguage || "English",
        channel: row.kind,
        intent: row.intent as (typeof MESSAGE_INTENTS)[number],
        recipient: person
          ? {
              kind: "person" as const,
              name: person.displayName,
              title: person.title,
              team: team?.name ?? null,
              responsibilities: person.responsibilities,
              profile: person.profile,
            }
          : team
            ? {
                kind: "team" as const,
                name: team.name,
                function: team.function,
                contactFor: team.contactFor,
                escalationPath: team.escalationPath,
              }
            : null,
        issues: issues.map((i) => ({
          key: i.key,
          summary: i.summary,
          status: i.status,
          assignee: i.assigneeDisplay,
          due: i.dueDate,
          updated: i.updated,
        })),
        dependency: dep
          ? {
              label: dep.label,
              kind: dep.kind,
              externalRef: dep.externalRef,
              status: dep.status,
              requestedAt: dep.requestedAt,
              expectedAt: dep.expectedAt,
              followups: chases
                .filter((f) => f.communicationId !== row.id)
                .map((f) => ({ at: f.at, channel: f.channel, summary: f.summary })),
            }
          : null,
        recent: recent.map((m) => ({
          at: m.sentAt ?? m.createdAt,
          subject: m.subject,
          body: m.bodyMd,
        })),
        memories: [
          ...notes.map((n) => n.content),
          ...(person?.notesMd ? [person.notesMd.slice(0, 500)] : []),
        ],
        notes: row.notesMd ?? "",
        instructions,
      } satisfies DraftContext;
    });

  const generate = (id: string, opts: { instruction?: string | null; today?: string } = {}) =>
    Effect.gen(function* () {
      const row = yield* q((d) =>
        d.select().from(communications).where(eq(communications.id, id)).get(),
      );
      if (!row)
        return yield* new CommsError({
          kind: "not_found",
          message: "That draft no longer exists.",
        });
      if (row.status === "sent")
        return yield* new CommsError({
          kind: "sent",
          message: "This message was already sent; start a new draft instead.",
        });
      const instruction = opts.instruction?.trim();
      const instructions = instruction ? [...row.instructions, instruction] : row.instructions;
      const ctx = yield* context(row, opts.today ?? localDate(), instructions);
      const { value } = yield* llm.object<DraftOutput>("draft_message", {
        schema: DraftOutputSchema,
        ...buildDraftPrompt(ctx),
        validate: (out) => validateDraft(out, ctx),
      });
      const variant = row.variant ?? "standard";
      yield* q((d) =>
        d
          .update(communications)
          .set({
            variants: { short: value.short.trim(), standard: value.standard.trim() },
            subject: row.kind === "email" ? value.subject.trim() : null,
            bodyMd: value[variant].trim(),
            variant,
            instructions,
            language: ctx.language,
            generatedAt: nowIso(),
            status: "draft",
          })
          .where(eq(communications.id, id)),
      );
    });

  return Comms.of({ generate });
});

export const CommsLive = Layer.effect(Comms, make);

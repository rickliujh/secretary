/**
 * Directory reads and user-initiated local writes (teams, people). These are
 * the user's own edits, not inferred memories, so they need no proposal.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { contextNotes, jiraIssues, people, teams } from "@/db/schema";
import { newId } from "@/lib/ids";
import { query } from "@/services/db";
import {
  compactProfile,
  normalizeUsername,
  type PersonInput,
  PersonInputSchema,
  type TeamInput,
  TeamInputSchema,
} from "./schema";

export const listTeams = query((db) => db.select().from(teams).orderBy(asc(teams.name)).all());
export const listPeople = query((db) =>
  db.select().from(people).orderBy(asc(people.displayName)).all(),
);

export type Team = typeof teams.$inferSelect;
export type Person = typeof people.$inferSelect;

export const getTeam = (id: string) =>
  Effect.gen(function* () {
    const team = yield* query((db) => db.select().from(teams).where(eq(teams.id, id)).get());
    if (!team) return null;
    const members = yield* query((db) =>
      db.select().from(people).where(eq(people.teamId, id)).orderBy(asc(people.displayName)).all(),
    );
    return { team, members };
  });

export const getPerson = (id: string) =>
  Effect.gen(function* () {
    const person = yield* query((db) => db.select().from(people).where(eq(people.id, id)).get());
    if (!person) return null;
    const team = person.teamId
      ? ((yield* query((db) =>
          db
            .select()
            .from(teams)
            .where(eq(teams.id, person.teamId ?? ""))
            .get(),
        )) ?? null)
      : null;
    const username = normalizeUsername(person.jiraUsername);
    const issues = username
      ? yield* query((db) =>
          db
            .select({
              key: jiraIssues.key,
              summary: jiraIssues.summary,
              status: jiraIssues.status,
              statusCategory: jiraIssues.statusCategory,
              updated: jiraIssues.updated,
            })
            .from(jiraIssues)
            .where(
              and(sql`lower(${jiraIssues.assignee}) = ${username}`, eq(jiraIssues.stale, false)),
            )
            .orderBy(sql`${jiraIssues.updated} DESC`)
            .limit(50)
            .all(),
        )
      : [];
    return { person, team, issues };
  });

export const createTeam = (input: TeamInput) =>
  Effect.gen(function* () {
    const v = TeamInputSchema.parse(input);
    const id = newId();
    yield* query((db) => db.insert(teams).values({ id, ...v }));
    return id;
  });

export const updateTeam = (id: string, input: TeamInput) =>
  query((db) => db.update(teams).set(TeamInputSchema.parse(input)).where(eq(teams.id, id)));

/** Members stay as contacts without a team; the team's notes are removed. */
export const deleteTeam = (id: string) =>
  Effect.gen(function* () {
    yield* query((db) => db.update(people).set({ teamId: null }).where(eq(people.teamId, id)));
    yield* query((db) =>
      db
        .delete(contextNotes)
        .where(and(eq(contextNotes.subjectType, "team"), eq(contextNotes.subjectId, id))),
    );
    yield* query((db) => db.delete(teams).where(eq(teams.id, id)));
  });

const personValues = (input: PersonInput) => {
  const v = PersonInputSchema.parse(input);
  return { ...v, profile: compactProfile(v.profile) };
};

export const createPerson = (input: PersonInput) =>
  Effect.gen(function* () {
    const id = newId();
    yield* query((db) => db.insert(people).values({ id, ...personValues(input) }));
    return id;
  });

export const updatePerson = (id: string, input: PersonInput) =>
  query((db) => db.update(people).set(personValues(input)).where(eq(people.id, id)));

export const deletePerson = (id: string) =>
  Effect.gen(function* () {
    yield* query((db) =>
      db
        .delete(contextNotes)
        .where(and(eq(contextNotes.subjectType, "person"), eq(contextNotes.subjectId, id))),
    );
    yield* query((db) => db.delete(people).where(eq(people.id, id)));
  });

/** Lower-cased Jira user id (username or account ID) -> contact, for linking assignees and reporters. */
export const contactsByUsername = Effect.map(
  query((db) =>
    db
      .select({ id: people.id, displayName: people.displayName, jiraUsername: people.jiraUsername })
      .from(people)
      .where(isNotNull(people.jiraUsername))
      .all(),
  ),
  (rows) =>
    new Map(
      rows.map((r) => [
        normalizeUsername(r.jiraUsername),
        { id: r.id, displayName: r.displayName },
      ]),
    ),
);

export type JiraUserSuggestion = {
  username: string;
  displayName: string;
  email: string | null;
  issues: number;
};

/**
 * Jira users seen in the cache (assignees and reporters) with no matching
 * contact, most frequent first. Creating one is a one-click user action.
 */
export const jiraUsersWithoutContact = Effect.gen(function* () {
  const rows = yield* query((db) =>
    db.all<[string, string | null, string | null]>(sql`
      SELECT ${jiraIssues.assignee}, ${jiraIssues.assigneeDisplay}, json_extract(${jiraIssues.raw}, '$.assignee.emailAddress')
        FROM ${jiraIssues} WHERE ${jiraIssues.assignee} IS NOT NULL
      UNION ALL
      SELECT ${jiraIssues.reporter}, ${jiraIssues.reporterDisplay}, json_extract(${jiraIssues.raw}, '$.reporter.emailAddress')
        FROM ${jiraIssues} WHERE ${jiraIssues.reporter} IS NOT NULL`),
  );
  const known = yield* contactsByUsername;
  const byUser = new Map<string, JiraUserSuggestion>();
  for (const [username, display, email] of rows) {
    const key = normalizeUsername(username);
    if (!key || known.has(key)) continue;
    const entry = byUser.get(key) ?? {
      username,
      displayName: display ?? username,
      email: email ?? null,
      issues: 0,
    };
    entry.issues += 1;
    if (!entry.email && email) entry.email = email;
    byUser.set(key, entry);
  }
  return [...byUser.values()].sort(
    (a, b) => b.issues - a.issues || a.displayName.localeCompare(b.displayName),
  );
});

/**
 * The Jira projects of contacts and teams (FR-19.7, D61, Phase 26): where the
 * "waiting on someone" playbook looks for the owner's ticket. Written by hand
 * in the contact and team sheets (`by: "user"`), or inferred after each sync
 * (`by: "sync"`): a person works in the projects of the synced tickets
 * assigned to them, and a team in its members' projects. Inferred entries are
 * replaced at every sync; the user's stay until the user removes them. An
 * inferred entry the user removed stays as `off`, so a sync does not add it
 * back, until the user restores it.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { type JiraProjectEntry, jiraIssues, people, teams } from "@/db/schema";
import { query } from "@/services/db";
import { normalizeUsername } from "./schema";

const KEY = /^[A-Z][A-Z0-9_]+$/;

const same = (a: readonly JiraProjectEntry[], b: readonly JiraProjectEntry[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The user's entries as they are, then the inferred ones they do not already
 * name, sorted, and the inferred ones the user removed (`off`), kept as they are.
 */
export function mergeInferred(
  current: readonly JiraProjectEntry[] | null | undefined,
  inferred: Iterable<string>,
): JiraProjectEntry[] {
  const mine = (current ?? []).filter((e) => e.by === "user");
  const off = (current ?? []).filter((e) => e.by === "sync" && e.off);
  const named = new Set([...mine, ...off].map((e) => e.key));
  const sync = [...new Set(inferred)]
    .filter((k) => KEY.test(k) && !named.has(k))
    .sort()
    .map((key) => ({ key, by: "sync" as const }));
  return [...mine, ...sync, ...off];
}

/** An inferred entry removed (`off`) or restored by the user. */
export function withInferredOff(
  current: readonly JiraProjectEntry[] | null | undefined,
  key: string,
  off: boolean,
): JiraProjectEntry[] {
  return (current ?? []).map((e) =>
    e.by === "sync" && e.key === key
      ? off
        ? { key, by: "sync", off: true }
        : { key, by: "sync" }
      : e,
  );
}

/** The user's own entries replaced by `keys` (upper-cased, valid keys only); inferred ones kept apart. */
export function withUserProjects(
  current: readonly JiraProjectEntry[] | null | undefined,
  keys: readonly string[],
): JiraProjectEntry[] {
  const mine = [...new Set(keys.map((k) => k.trim().toUpperCase()))].filter((k) => KEY.test(k));
  const chosen = new Set(mine);
  return [
    ...mine.map((key) => ({ key, by: "user" as const })),
    ...(current ?? []).filter((e) => e.by === "sync" && !chosen.has(e.key)),
  ];
}

/**
 * After a sync: each contact with a Jira user gets the projects of the synced
 * tickets assigned to them, and each team the union of its members'. Returns
 * how many rows changed.
 */
export const inferJiraProjects = Effect.gen(function* () {
  const assigned = yield* query((d) =>
    d
      .selectDistinct({ assignee: jiraIssues.assignee, project: jiraIssues.projectKey })
      .from(jiraIssues)
      .where(and(eq(jiraIssues.stale, false), isNotNull(jiraIssues.assignee)))
      .all(),
  );
  const byUser = new Map<string, Set<string>>();
  for (const r of assigned) {
    const u = normalizeUsername(r.assignee);
    if (!u) continue;
    byUser.set(u, (byUser.get(u) ?? new Set()).add(r.project));
  }
  const persons = yield* query((d) =>
    d
      .select({
        id: people.id,
        jira: people.jiraUsername,
        teamId: people.teamId,
        projects: people.jiraProjects,
      })
      .from(people)
      .all(),
  );
  let changed = 0;
  const memberKeys = new Map<string, Set<string>>();
  for (const p of persons) {
    const next = mergeInferred(p.projects, byUser.get(normalizeUsername(p.jira)) ?? []);
    if (!same(next, p.projects ?? [])) {
      yield* query((d) => d.update(people).set({ jiraProjects: next }).where(eq(people.id, p.id)));
      changed++;
    }
    if (p.teamId) {
      const set = memberKeys.get(p.teamId) ?? new Set<string>();
      for (const e of next) if (!e.off) set.add(e.key);
      memberKeys.set(p.teamId, set);
    }
  }
  const teamRows = yield* query((d) =>
    d.select({ id: teams.id, projects: teams.jiraProjects }).from(teams).all(),
  );
  for (const t of teamRows) {
    const next = mergeInferred(t.projects, memberKeys.get(t.id) ?? []);
    if (same(next, t.projects ?? [])) continue;
    yield* query((d) => d.update(teams).set({ jiraProjects: next }).where(eq(teams.id, t.id)));
    changed++;
  }
  return changed;
});

/** Rewrites the project entries of a contact or a team (a local write, D17). */
const updateProjects = (
  subject: "person" | "team",
  id: string,
  f: (current: readonly JiraProjectEntry[]) => JiraProjectEntry[],
) =>
  Effect.gen(function* () {
    if (subject === "person") {
      const row = yield* query((d) =>
        d.select({ projects: people.jiraProjects }).from(people).where(eq(people.id, id)).get(),
      );
      if (!row) return;
      yield* query((d) =>
        d
          .update(people)
          .set({ jiraProjects: f(row.projects ?? []) })
          .where(eq(people.id, id)),
      );
      return;
    }
    const row = yield* query((d) =>
      d.select({ projects: teams.jiraProjects }).from(teams).where(eq(teams.id, id)).get(),
    );
    if (!row) return;
    yield* query((d) =>
      d
        .update(teams)
        .set({ jiraProjects: f(row.projects ?? []) })
        .where(eq(teams.id, id)),
    );
  });

/** The sheets' editor: the user's own project keys for a contact or a team. */
export const setJiraProjects = (subject: "person" | "team", id: string, keys: readonly string[]) =>
  updateProjects(subject, id, (current) => withUserProjects(current, keys));

/** The sheets' editor: removes (`off`) or restores a project a sync inferred. */
export const setInferredOff = (subject: "person" | "team", id: string, key: string, off: boolean) =>
  updateProjects(subject, id, (current) => withInferredOff(current, key, off));

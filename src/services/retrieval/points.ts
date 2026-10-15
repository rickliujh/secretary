/**
 * The story point scale the classify prompt offers (D55): the point values the
 * user's synced tickets use, so a suggestion stays on the team's scale.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { jiraIssues } from "@/db/schema";
import { query } from "@/services/db";

/** How many values the scale lists at most. */
export const SCALE_SIZE = 8;

/** How often one project uses one point value. */
export type PointUse = { projectKey: string; points: number | null; count: number };

/**
 * The scale from the cache's point values: the projects in play when their
 * tickets have points, else every cached project; the most frequent values
 * (ties: the smaller first), at most `size`, sorted ascending. Empty when no
 * cached ticket has points.
 */
export function pointScale(
  uses: readonly PointUse[],
  inPlay: readonly string[],
  size = SCALE_SIZE,
): number[] {
  const valid = uses.filter(
    (u): u is PointUse & { points: number } =>
      typeof u.points === "number" && Number.isFinite(u.points) && u.points >= 0 && u.count > 0,
  );
  const projects = new Set(inPlay);
  const local = valid.filter((u) => projects.has(u.projectKey));
  const counts = new Map<number, number>();
  for (const u of local.length ? local : valid)
    counts.set(u.points, (counts.get(u.points) ?? 0) + u.count);
  return [...counts]
    .sort(([a, ca], [b, cb]) => cb - ca || a - b)
    .slice(0, size)
    .map(([points]) => points)
    .sort((a, b) => a - b);
}

/**
 * How often each project uses each point value, from cached tickets that are
 * not stale. Epics never get points (D55) and sub-tasks are left out, as in
 * sprint points (D35).
 */
export const pointUses = query((d) =>
  d
    .select({
      projectKey: jiraIssues.projectKey,
      points: jiraIssues.storyPoints,
      count: sql<number>`count(*)`,
    })
    .from(jiraIssues)
    .where(
      and(
        eq(jiraIssues.stale, false),
        isNotNull(jiraIssues.storyPoints),
        eq(jiraIssues.isSubtask, false),
        sql`lower(${jiraIssues.issueType}) <> 'epic'`,
      ),
    )
    .groupBy(jiraIssues.projectKey, jiraIssues.storyPoints)
    .all(),
);

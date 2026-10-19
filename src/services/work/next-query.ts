/**
 * Next moves where the user is (FR-19.8, D62): the reads behind the Work
 * tab's "Next" strip, Today's "You're on" panel and the Drafts page's work
 * line. Code only; the ranking is `next.ts`.
 */
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { workItemIssues, workItems } from "@/db/schema";
import { localDate, localDateOf } from "@/lib/dates";
import { query } from "@/services/db";
import { userActiveSprints } from "@/services/sprints/active";
import { lastSprintDay, workingDaysLeft } from "@/services/sprints/fit";
import { fitData } from "@/services/sprints/fit-query";
import { type ItemFacts, loadItemFacts } from "./facts";
import { movesOf, type NextMove, type NextSprint, rankMoves } from "./next";
import { heldOfItem, pendingOutcomes } from "./outcomes";
import { currentItem } from "./park";
import { parseState } from "./schema";

/** The user's active sprint as next moves rank against it (D57's last day). */
export const userSprint = (today = localDate()) =>
  Effect.map(fitData, (data): NextSprint => {
    const s = userActiveSprints(data.state.sprints, data.mine, data.me)[0];
    const last = s ? lastSprintDay(s, data.lastDay) : null;
    if (!s || !last) return null;
    return { name: s.name, lastDay: last, daysLeft: workingDaysLeft(s, today, data.lastDay) };
  });

/** Every move of one item, ranked (not capped); `known` saves reading the facts again. */
export const movesOfItem = (itemId: string, today = localDate(), known?: ItemFacts) =>
  Effect.gen(function* () {
    const item = yield* query((d) =>
      d.select().from(workItems).where(eq(workItems.id, itemId)).get(),
    );
    if (!item) return [] as NextMove[];
    const facts = known ?? (yield* loadItemFacts(itemId, { today }));
    const cards = (yield* pendingOutcomes).filter((c) => c.workItemId === itemId);
    const held = yield* heldOfItem(itemId, today);
    const sprint = yield* userSprint(today);
    const userNote = item.noteEditedAt && item.note ? item.note : null;
    const moves = movesOf(
      {
        id: item.id,
        state: parseState(item.state),
        userNote,
        noteOn: item.noteEditedAt ? localDateOf(item.noteEditedAt) : null,
      },
      facts,
      cards,
      held,
      today,
      sprint,
    );
    return rankMoves(moves, { limit: moves.length });
  });

/** What a page shows of an item: its name, where it stands, and its moves. */
export type WorkSummary = {
  id: string;
  name: string;
  current: boolean;
  currentStep: string | null;
  nextExpected: { what: string; on: string | null } | null;
  /** The ticket one click opens: the first open primary ticket. */
  issueKey: string | null;
  moves: NextMove[];
};

const summarise = (item: typeof workItems.$inferSelect, current: boolean, today: string) =>
  Effect.gen(function* () {
    const state = parseState(item.state);
    const facts = yield* loadItemFacts(item.id, { today });
    const open = facts.tickets.find(
      (t) => t.role === "primary" && !t.unknown && t.statusCategory !== "done",
    );
    return {
      id: item.id,
      name: item.name,
      current,
      currentStep: state?.currentStep || null,
      nextExpected: state?.nextExpected ?? null,
      issueKey: open?.key ?? facts.tickets[0]?.key ?? null,
      moves: yield* movesOfItem(item.id, today, facts),
    } satisfies WorkSummary;
  });

/** Today's "You're on" panel: the current item, or null while none is current. */
export const currentWork = (today = localDate()) =>
  Effect.gen(function* () {
    const current = yield* currentItem(today);
    if (!current) return null;
    const item = yield* query((d) =>
      d.select().from(workItems).where(eq(workItems.id, current.id)).get(),
    );
    return item ? yield* summarise(item, true, today) : null;
  });

/**
 * The Drafts page's work line: the active item the first of these tickets
 * belongs to, or null when none does.
 */
export const workOfKeys = (keys: readonly string[], today = localDate()) =>
  Effect.gen(function* () {
    if (keys.length === 0) return null;
    const rows = yield* query((d) =>
      d
        .select({ key: workItemIssues.issueKey, item: workItems })
        .from(workItemIssues)
        .innerJoin(workItems, eq(workItems.id, workItemIssues.workItemId))
        .where(inArray(workItemIssues.issueKey, [...keys]))
        .all(),
    );
    const active = rows.filter((r) => r.item.status === "active");
    const hit = keys.map((k) => active.find((r) => r.key === k)).find((r) => !!r);
    if (!hit) return null;
    const current = yield* currentItem(today);
    return yield* summarise(hit.item, current?.id === hit.item.id, today);
  });

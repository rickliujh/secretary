/**
 * Seeding an eval case's work item (D61 Reads, prompt version 15) after the
 * sync: its tickets as the cache would hold them, the item with its state, a
 * note the user wrote for its commitments, and an open wait. Used by the live
 * eval and checked without a model by `work-seed.test.ts`.
 */
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { dependencies, workItemIssues, workItems } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { createDependency } from "@/services/dependencies/queries";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { appendEvents } from "@/services/work/events";
import type { WorkState } from "@/services/work/schema";
import { blockedByLink, insertIssues, issue } from "@/test/work";
import type { EvalWorkItem } from "./cases";

/** The fixtures' active sprint. */
const ACTIVE_SPRINT = "Payments 15";

const nameOf = (handle: string) => handle.charAt(0).toUpperCase() + handle.slice(1);

/** Seeds `w`; `contacts` maps the case's handles to the contact ids made in this run. */
export const seedWorkItem = (w: EvalWorkItem, contacts: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const me = (yield* getState(SYNC_KEYS.username)) ?? "me";
    const at = "2026-09-21T09:00:00.000Z";
    yield* insertIssues(
      w.issues.map((i) =>
        issue(i.key, {
          summary: i.summary,
          status: i.status,
          statusCategory: i.statusCategory,
          issueType: i.mine ? "Story" : "Task",
          assignee: i.mine ? me : "sam.o",
          assigneeDisplay: i.mine ? "Me" : "Sam Ortiz",
          sprint: i.mine ? ACTIVE_SPRINT : null,
          created: at,
          updated: at,
          syncedAt: at,
          raw: i.blockedBy ? { issuelinks: [blockedByLink(i.blockedBy)] } : {},
        }),
      ),
    );
    const id = newId();
    const contactOf = (handle: string) => contacts[handle] ?? null;
    yield* query((d) =>
      d
        .insert(workItems)
        .values({ id, name: w.name, nameBy: "state", goal: w.goal, createdAt: at }),
    );
    yield* query((d) =>
      d.insert(workItemIssues).values(
        w.issues.map((i) => ({
          issueKey: i.key,
          workItemId: id,
          role: i.mine ? ("primary" as const) : ("related" as const),
          addedAt: at,
        })),
      ),
    );
    // The user's note the commitments were said in, already folded into the state.
    const [noteId] = w.commitments?.length
      ? yield* appendEvents([
          {
            kind: "note",
            at: "2026-09-22T10:00:00.000Z",
            actor: "me",
            summary: "Your note",
            data: {
              text: w.commitments
                .map(
                  (c) => `I promised ${nameOf(c.to)} ${c.what}${c.dueOn ? ` by ${c.dueOn}` : ""}.`,
                )
                .join(" "),
            },
            workItemId: id,
            attachedBy: "user",
            applied: true,
          },
        ])
      : [];
    const state: WorkState = {
      goal: w.goal,
      currentStep: w.currentStep,
      nextExpected: w.nextExpected ?? null,
      commitments: (w.commitments ?? []).map((c) => ({
        what: c.what,
        toPersonId: contactOf(c.to),
        toName: contactOf(c.to) ? null : nameOf(c.to),
        dueOn: c.dueOn,
        saidIn: noteId ?? "",
        status: "open",
      })),
      openQuestions: [],
      people: [],
    };
    yield* query((d) =>
      d
        .update(workItems)
        .set({ state, stateVersion: 1, stateUpdatedAt: nowIso() })
        .where(eq(workItems.id, id)),
    );
    if (w.wait) {
      const waitId = yield* createDependency({
        issueKey: w.wait.issueKey,
        kind: "person",
        label: w.wait.label,
        ownerPersonId: contactOf(w.wait.owner),
        expectedAt: w.wait.expectedAt ?? null,
      });
      // Asked before the eval's today, not when the case runs.
      yield* query((d) =>
        d
          .update(dependencies)
          .set({ requestedAt: "2026-09-18T09:00:00.000Z" })
          .where(eq(dependencies.id, waitId)),
      );
    }
    return id;
  });

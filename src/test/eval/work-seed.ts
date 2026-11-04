/**
 * Seeding an eval case's work item (D61 Reads, prompt version 15) after the
 * sync: its tickets as the cache would hold them, the item with its state, a
 * note the user wrote for its commitments, and an open wait. Used by the live
 * eval and checked without a model by `work-seed.test.ts`.
 */
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { dependencies, inboxItems, proposals, workItemIssues, workItems } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { createDependency } from "@/services/dependencies/queries";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { appendEvents } from "@/services/work/events";
import type { WorkState } from "@/services/work/schema";
import { blockedByLink, insertIssues, issue } from "@/test/work";
import type { EvalCreated, EvalWait, EvalWorkItem } from "./cases";

/** A case's seed could not be made from what the model proposed. */
export class SeedError extends Data.TaggedError("SeedError")<{ readonly message: string }> {}

/** A ticket the user's approval made, in the cache as the sync would hold it. */
const cacheCreated = (key: string, summary: string, issueType: string, at: string) =>
  Effect.gen(function* () {
    const me = (yield* getState(SYNC_KEYS.username)) ?? "me";
    yield* insertIssues([
      issue(key, {
        summary,
        issueType,
        status: "To Do",
        statusCategory: "new",
        assignee: me,
        assigneeDisplay: "Me",
        sprint: null,
        created: at,
        updated: at,
        syncedAt: at,
      }),
    ]);
  });

/**
 * The user approves a thread's first turn (D69): its first create_issue is
 * executed as `key` (and the ticket cached), and the wait it linked to that
 * ticket, if any, is made as `wait` and its link_dependency executed. Fails
 * when the turn proposed no create. Other proposals stay as they are.
 */
export const approveFirstTurn = (inboxItemId: string, key: string, wait?: EvalWait) =>
  Effect.gen(function* () {
    const rows = yield* query((d) =>
      d.select().from(proposals).where(eq(proposals.inboxItemId, inboxItemId)).all(),
    );
    const live = rows.filter((r) => r.status === "pending");
    const create = live.find((r) => r.kind === "create_issue");
    const made = create?.payload as { ref?: string; summary?: string; issueType?: string } | null;
    if (!create || !made)
      return yield* new SeedError({ message: "the first turn proposed no create_issue" });
    const at = nowIso();
    yield* cacheCreated(key, made.summary ?? key, made.issueType ?? "Story", at);
    yield* query((d) =>
      d
        .update(proposals)
        .set({ status: "executed", result: { issueKey: key }, decidedAt: at })
        .where(eq(proposals.id, create.id)),
    );
    if (!wait) return;
    const dependencyId = yield* createDependency({
      issueKey: key,
      kind: wait.kind ?? "person",
      label: wait.label,
      externalRef: wait.externalRef ?? null,
      expectedAt: wait.expectedAt ?? null,
    });
    const link = live.find(
      (r) => r.kind === "link_dependency" && (r.payload as { target?: string }).target === made.ref,
    );
    if (link)
      yield* query((d) =>
        d
          .update(proposals)
          .set({ status: "executed", result: { dependencyId }, decidedAt: at })
          .where(eq(proposals.id, link.id)),
      );
  });

/**
 * Seeds a ticket an earlier thread created on the user's approval (D66): the
 * thread with its executed create, two days before the eval's today, and the
 * ticket in the cache as the sync would hold it.
 */
export const seedCreated = (c: EvalCreated) =>
  Effect.gen(function* () {
    const at = "2026-09-22T09:00:00.000Z";
    yield* cacheCreated(c.key, c.summary, c.issueType, at);
    const thread = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id: thread,
        source: "typed",
        senderPersonId: null,
        rawText: c.request,
        receivedAt: at,
        status: "filed",
        summary: c.request,
      }),
    );
    const [project = "PAY"] = c.key.split("-");
    yield* query((d) =>
      d.insert(proposals).values({
        id: newId(),
        inboxItemId: thread,
        kind: "create_issue",
        payload: {
          kind: "create_issue",
          ref: "$new:1",
          projectKey: project,
          issueType: c.issueType,
          summary: c.summary,
        },
        status: "executed",
        result: { issueKey: c.key },
        createdAt: at,
        decidedAt: "2026-09-22T10:00:00.000Z",
      }),
    );
    return thread;
  });

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
        kind: w.wait.kind ?? "person",
        label: w.wait.label,
        ownerPersonId: w.wait.owner ? contactOf(w.wait.owner) : null,
        externalRef: w.wait.externalRef ?? null,
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

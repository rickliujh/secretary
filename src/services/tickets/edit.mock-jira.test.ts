/**
 * FR-17 acceptance over real HTTP (Phase 21 checklist): in the FR-16 AC sprint
 * (three working days left, two open 1-point tickets of the user's, 1 point =
 * 0.5 days), one Save that sets a backlog ticket's points to 2, adds a label
 * and picks the active sprint shows "fits" before saving, and afterwards the
 * ticket is in that sprint with 2 points and the label; picking Backlog moves
 * it out again. A failed write stops the Save and says what was saved. Real
 * Sync and Executor against scripts/mock-jira.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { describeError } from "@/app/errors";
import { ExecutorLive } from "@/services/executor/live";
import { lastSprintDay, workingDaysBetween } from "@/services/sprints/fit";
import { knownSprints, ticketJoinSprint, ticketSprintFit } from "@/services/sprints/fit-query";
import {
  BACKLOG,
  joinChecked,
  joinOption,
  joinValue,
  sprintChoices,
} from "@/services/sprints/options";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { boardSprints, createHandler, generate } from "../../../scripts/mock-jira";
import { editOutcomeText, editValues, type TicketEditValues, ticketEditSteps } from "./edit";
import { ticketDetail } from "./queries";
import { saveTicketEdit } from "./save-edit";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const DAY = 86_400_000;
const active = boardSprints(1).find((s) => s.state === "active");
if (!active) throw new Error("fixture: no active sprint");
// Three working days left, as in the FR-16 AC (fit.mock-jira.test.ts).
const last = lastSprintDay({
  start: active.startDate.slice(0, 10),
  end: active.endDate.slice(0, 10),
  endAt: active.endDate,
});
const today = (() => {
  let ms = Date.parse(`${last}T00:00:00Z`);
  while (workingDaysBetween(new Date(ms).toISOString().slice(0, 10), last ?? "") < 3) ms -= DAY;
  return new Date(ms).toISOString().slice(0, 10);
})();

/** The FR-16 AC sprint, plus a fresh unestimated backlog ticket of the user's without labels. */
function setup() {
  const issues = generate(80);
  const all = [...issues.values()];
  const me = all.find((i) => i.assignee?.name === "me")?.assignee;
  const ana = all.find((i) => i.assignee?.name === "ana.b")?.assignee;
  if (!me || !ana || !active) throw new Error("fixture: users");
  for (const i of all) if (i.assignee?.name === "me") i.assignee = ana;
  const open = all.filter((i) => i.project === "PAY" && (i.type === "Story" || i.type === "Task"));
  const [one, two, ticket, old] = open;
  if (!one || !two || !ticket || !old) throw new Error("fixture: tickets");
  // An older ticket back in the backlog: its Sprint field still names the closed
  // sprint it was created in.
  Object.assign(old, { assignee: ana, status: "To Do", inBacklog: true, movedToSprint: undefined });
  for (const i of [one, two]) {
    i.assignee = me;
    i.status = "To Do";
    i.points = 1;
    i.movedToSprint = active.id;
    i.inBacklog = false;
  }
  Object.assign(ticket, {
    assignee: me,
    status: "To Do",
    points: null,
    labels: [],
    epic: null,
    inBacklog: true,
    movedToSprint: undefined,
    // Created in the active sprint's time, so no closed sprint is on it: just the backlog.
    created: new Date().toISOString().replace("Z", "+0000"),
  });
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const layer = Layer.provideMerge(
    ExecutorLive,
    Layer.provideMerge(
      SyncLive,
      jiraTestLayer((input, init) => fetch(input, init), {
        ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
        sprint: { daysPerPoint: 0.5, lastDay: "jira" },
      }),
    ),
  );
  return { issues, layer, key: ticket.key, notEpic: one.key, oldKey: old.key };
}

/** The dialog for the cached ticket: its issue, sprint choices and starting values. */
const openDialog = (key: string) =>
  Effect.gen(function* () {
    const issue = (yield* ticketDetail(key))?.issue;
    if (!issue) throw new Error(`${key} not cached`);
    const state = yield* knownSprints;
    const choices = sprintChoices({
      sprints: state.sprints,
      boardProjects: state.boardProjects,
      projectKey: issue.projectKey,
      issueType: issue.issueType,
      isSubtask: issue.isSubtask,
      current: issue.sprint,
      today,
    });
    if (choices.kind !== "pick") throw new Error("no sprint options");
    const names = Object.fromEntries(choices.options.map((o) => [o.value, o.name]));
    return { issue, choices, names, initial: editValues(issue, choices.value) };
  });

const save = (key: string, change: (v: TicketEditValues) => TicketEditValues) =>
  Effect.gen(function* () {
    const d = yield* openDialog(key);
    const steps = ticketEditSteps(d.issue, d.initial, change(d.initial), d.names);
    return yield* saveTicketEdit(steps);
  });

describe("editing an existing ticket against the mock Jira (FR-17 AC)", () => {
  test("one Save sets points, adds a label and joins the active sprint; Backlog moves it out", async () => {
    const { issues, layer, key } = setup();
    const sprintId = String(active.id);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const before = yield* openDialog(key);
          const join = yield* ticketJoinSprint(before.issue.projectKey, today);
          // Before saving: the room line for the picked sprint with the dialog's 2 points.
          const fit = yield* ticketSprintFit(
            active.id,
            {
              label: before.issue.summary,
              points: 2,
              assignee: before.issue.assignee,
              assigneeName: before.issue.assigneeDisplay,
            },
            today,
          );
          const saved = yield* save(key, (v) => ({
            ...v,
            points: "2",
            labels: `${v.labels} needs-review`,
            sprint: sprintId,
          }));
          const after = yield* openDialog(key);
          const back = yield* save(key, (v) => ({ ...v, sprint: BACKLOG }));
          const out = yield* openDialog(key);
          return { before, join, fit, saved, after, back, out };
        }),
        layer,
      ),
    );
    expect(r.before.choices.value).toBe(BACKLOG);
    // Its team (D59): Data Center's Advanced Roadmaps gives only the team's id.
    expect(r.before.issue.team).toBe("Team 12");
    // The switch joins the proposals' sprint; turning it on picks it in the select.
    expect(r.join).toMatchObject({ id: active.id, name: active.name, daysLeft: 3 });
    expect(r.join?.when).toMatch(/^ends \w+ \d+ \w+, 3 working days left$/);
    const option = joinOption(r.before.choices, r.join?.id ?? null);
    if (!option) throw new Error("no switch");
    expect(joinChecked(option, r.before.choices.value)).toBe(false);
    expect(joinValue(option, true)).toBe(sprintId);
    expect(joinChecked(option, r.after.choices.value)).toBe(true);
    expect(r.before.choices.options.find((o) => o.value === sprintId)).toMatchObject({
      name: active.name,
      pickable: true,
    });
    expect(r.fit?.sprint).toMatchObject({ name: active.name, daysLeft: 3 });
    expect(r.fit?.fit).toMatchObject({ verdict: "fits", days: 2, points: 4 });
    expect(r.fit?.fit.headline).toBe("Fits: about 2 of 3 working days");
    expect(r.fit?.fit.details.at(-2)).toBe("This ticket: 2 points, about 1 day");

    expect(r.saved.failed).toBeNull();
    expect(r.saved.saved.map((s) => s.action.kind)).toEqual(["update_fields", "move_to_sprint"]);
    expect(editOutcomeText(key, r.saved).title).toBe(
      `Saved story points, labels and the move to ${active.name} on ${key}`,
    );
    expect(r.after.issue).toMatchObject({
      sprint: active.name,
      storyPoints: 2,
      labels: ["needs-review"],
    });
    expect(r.after.choices.value).toBe(sprintId);

    expect(r.back.failed).toBeNull();
    expect(r.back.saved.map((s) => s.action.kind)).toEqual(["move_to_backlog"]);
    expect(r.out.issue.sprint).toBeNull();
    expect(r.out.choices.value).toBe(BACKLOG);
    expect(r.out.issue).toMatchObject({ storyPoints: 2, labels: ["needs-review"] });
    expect(issues.get(key)?.inBacklog).toBe(true);
  });

  test("a failed write stops the Save and says what was saved and what was not", async () => {
    const { issues, layer, key, notEpic } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          return yield* save(key, (v) => ({
            ...v,
            points: "3",
            epic: notEpic,
            sprint: String(active.id),
          }));
        }),
        layer,
      ),
    );
    expect(r.saved.map((s) => s.action.kind)).toEqual(["update_fields"]);
    expect(r.failed?.step.action.kind).toBe("set_epic");
    expect(r.skipped.map((s) => s.action.kind)).toEqual(["move_to_sprint"]);
    const error = describeError(r.failed?.error);
    expect(editOutcomeText(key, r, error.description).description).toStartWith(
      `Saved story points. Not tried: the move to ${active.name}.`,
    );
    // The points were written; the sprint move was not tried.
    expect(issues.get(key)).toMatchObject({ points: 3, inBacklog: true });
  });

  test("a backlog ticket last in a closed sprint shows Backlog with a hint, and keeping it writes nothing", async () => {
    const { layer, oldKey } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const d = yield* openDialog(oldKey);
          return { d, steps: ticketEditSteps(d.issue, d.initial, d.initial, d.names) };
        }),
        layer,
      ),
    );
    expect(r.d.issue.sprint).not.toBeNull();
    expect(r.d.choices.value).toBe(BACKLOG);
    expect(r.d.choices.hint).toBe(`Last in ${r.d.issue.sprint} (closed)`);
    expect(r.steps).toEqual([]);
  });
});

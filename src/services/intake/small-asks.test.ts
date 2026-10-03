/** Intake with a small-asks home (D44), over the fixtures and a scripted model. */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ItemSnapshot } from "@/prompts/classify";
import { createPerson } from "@/services/directory/queries";
import { promptOf, readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Intake } from ".";

const home = {
  smallAsks: {
    projectKey: "OPS",
    label: "small-ask",
    joinActiveSprint: true,
    hintDismissed: false,
  },
};
const e = {
  rationale: "Dana asked for numbers",
  evidence: "send me the Q3 numbers",
  confidence: 0.9,
};
const answer = {
  summary: "Dana wants the Q3 numbers by Friday",
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Dana the Q3 numbers",
      description: "",
      dueDate: "2026-09-25",
      issueType: "",
      ...e,
    },
    {
      kind: "link_dependency",
      target: "$new:1",
      dependencyKind: "team",
      label: "Finance export of Q3 totals",
      ...e,
    },
  ],
};
const text = "Hi Rick, can you send me the Q3 numbers by Friday? Finance has to export them first.";

const run = (settings: object, script: unknown) => {
  const { layer, models } = intakeTestLayer({ "std-m": [out(script)] }, [], { settings });
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* syncOnce;
        const dana = yield* createPerson({ displayName: "Dana Reyes", title: "Finance lead" });
        const res = yield* (yield* Intake).triage({
          text,
          source: "teams",
          senderPersonId: dana,
          today: TODAY,
        });
        return { dana, models, ...(yield* readThread(res.inboxItemId)) };
      }),
      layer,
    ),
  );
};

describe("intake with a small-asks home (FR-10.2)", () => {
  test("an ask becomes a ticket in the home: project, label, assignee, sprint and requester by code", async () => {
    const r = await run(home, answer);
    expect(promptOf(r.models.calls, 0)).toContain("Small-asks home: project OPS");
    const snap = r.items[0]?.snapshot as ItemSnapshot;
    expect(snap.smallAsks).toEqual({
      projectKey: "OPS",
      label: "small-ask",
      joinSprint: true,
      issueTypes: ["Task"],
      defaultType: "Task",
    });
    expect(r.props.map((p) => p.kind)).toEqual(["create_issue", "link_dependency"]);
    expect(r.props[0]?.payload).toMatchObject({
      projectKey: "OPS",
      issueType: "Task",
      summary: "Send Dana the Q3 numbers",
      assignee: "rliu",
      dueDate: "2026-09-25",
      labels: ["small-ask"],
      smallAsk: true,
      requesterPersonId: r.dana,
      joinSprint: true,
      descriptionMd: `_Asked by Dana Reyes via Teams on ${TODAY}:_\n\n> ${text}`,
    });
    expect(r.props[1]?.payload).toMatchObject({ target: "$new:1" });
  });

  test("a create that does not say whether it is a small ask is repaired", async () => {
    const { smallAsk: _drop, ...first } = answer.proposals[0] as Record<string, unknown>;
    const bad = { ...answer, proposals: [first, answer.proposals[1]] };
    const { layer, models } = intakeTestLayer({ "std-m": [out(bad), out(answer)] }, [], {
      settings: home,
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const res = yield* (yield* Intake).triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          return yield* readThread(res.inboxItemId);
        }),
        layer,
      ),
    );
    expect(promptOf(models.calls, 1)).toContain("set smallAsk to yes or no");
    expect(r.props[0]?.payload).toMatchObject({ smallAsk: true, requesterPersonId: null });
  });

  test("with no home set the model sees no small-ask field and creates stay as they were", async () => {
    const planned = {
      ...answer,
      proposals: [
        {
          ...answer.proposals[0],
          smallAsk: "",
          projectKey: "OPS",
          issueType: "Task",
          assignee: "",
        },
      ],
    };
    const r = await run({}, planned);
    expect(promptOf(r.models.calls, 0)).not.toContain("small ask");
    expect((r.items[0]?.snapshot as ItemSnapshot | undefined)?.smallAsks).toBeNull();
    expect(r.props[0]?.payload).toMatchObject({
      projectKey: "OPS",
      assignee: null,
      labels: [],
      smallAsk: false,
      requesterPersonId: null,
      joinSprint: false,
      descriptionMd: null,
    });
  });

  test("a revision keeps it a small ask with one provenance block", async () => {
    const revised = {
      ...answer,
      proposals: [{ ...answer.proposals[0], dueDate: "2026-09-28" }, answer.proposals[1]],
    };
    const { layer, models } = intakeTestLayer({ "std-m": [out(answer), out(revised)] }, [], {
      settings: home,
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            instruction: "Make it due Monday",
            today: TODAY,
          });
          return yield* readThread(first.inboxItemId);
        }),
        layer,
      ),
    );
    // The model saw its own description, not the block code added, and no assignee.
    const pending = promptOf(models.calls, 1);
    expect(pending).toContain('\\"smallAsk\\":\\"yes\\"');
    expect(pending).not.toContain("_Asked via");
    const current = r.props.filter((p) => p.status === "pending");
    expect(current[0]?.payload).toMatchObject({ smallAsk: true, dueDate: "2026-09-28" });
    const description = (current[0]?.payload as { descriptionMd?: string } | undefined)
      ?.descriptionMd;
    expect(description?.match(/_Asked via Teams/g)).toHaveLength(1);
  });
});

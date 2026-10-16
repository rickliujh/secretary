/**
 * New contacts and teams from intake and the chat (FR-18 AC, D60) over the
 * fixtures and a scripted model: "add Sarah Lee ... on the Payments team" makes a
 * team and a contact in it, approved into Context; a later paste about Sarah may
 * not add her again, and a paste naming bystanders adds nobody.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { getTeam, listPeople } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { promptOf, readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Intake } from ".";

const e = { rationale: "the user asked", evidence: "add Sarah Lee", confidence: 0.9 };
const answer = (proposals: Record<string, unknown>[]) => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals.map((p) => ({ ...e, ...p })),
});

function layerWith(answers: { text: string }[]) {
  const intake = intakeTestLayer({ "std-m": answers });
  return {
    layer: Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, intake.layer)),
    models: intake.models,
  };
}

const sarah = {
  kind: "create_person",
  personRef: "$person:1",
  displayName: "Sarah Lee",
  title: "Staff engineer",
  team: "$team:1",
};
const payments = { kind: "create_team", teamRef: "$team:1", name: "Payments" };

describe("new contacts and teams from intake (FR-18 AC)", () => {
  test("the chat adds a team and a contact in it; a later paste about her does not add her again", async () => {
    // Sarah's id is made when her proposal is approved; the scripted repair reads it then.
    let sarahId = "";
    const cert = {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "person",
      label: "Signed certificate from Sarah",
      expectedAt: "2026-09-25",
    };
    const { layer, models } = layerWith([
      // The model lists the contact first; the merge puts the team first.
      out(answer([sarah, payments])),
      out(
        answer([
          { ...sarah, team: null },
          { ...cert, ownerPersonId: "$person:1" },
        ]),
      ),
      {
        get text() {
          return JSON.stringify(answer([{ ...cert, ownerPersonId: sarahId }]));
        },
      },
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const svc = yield* Proposals;
          const first = yield* intake.triage({
            text: "add Sarah Lee, staff engineer on the Payments team, as a contact",
            source: "typed",
            author: "chat",
            senderPersonId: null,
            today: TODAY,
          });
          const proposed = (yield* readThread(first.inboxItemId)).props;
          const decided = yield* svc.approveAll(first.inboxItemId);
          const added = (yield* listPeople).find((p) => p.displayName === "Sarah Lee");
          sarahId = added?.id ?? "";
          const team = yield* getTeam(added?.teamId ?? "");
          const later = yield* intake.triage({
            text: "Sarah will send the signed certificate for PAY-2 by Friday.",
            source: "teams",
            senderPersonId: null,
            today: TODAY,
          });
          return {
            proposed: proposed.map((p) => p.payload),
            decided,
            added,
            team: team && { name: team.team.name, members: team.members.map((m) => m.id) },
            later: (yield* readThread(later.inboxItemId)).props.map((p) => p.payload),
          };
        }),
        layer,
      ),
    );
    expect(r.proposed).toMatchObject([
      { kind: "create_team", ref: "$team:1", name: "Payments" },
      { kind: "create_person", ref: "$person:1", team: "$team:1", displayName: "Sarah Lee" },
    ]);
    expect(r.decided.map((d) => d.status)).toEqual(["executed", "executed"]);
    expect(r.team).toEqual({ name: "Payments", members: [r.added?.id ?? "x"] });
    // The paste named Sarah, who is in Context now: a new contact is refused and repaired.
    expect(models.calls).toHaveLength(3);
    expect(promptOf(models.calls, 2)).toContain(`Sarah Lee is already a contact (${sarahId})`);
    expect(r.later).toMatchObject([{ kind: "link_dependency", ownerPersonId: sarahId }]);
  });

  test("a later item in the thread uses the contact an earlier one proposes", async () => {
    const cert = {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "person",
      label: "Signed certificate",
    };
    const { layer, models } = layerWith([
      out(answer([{ ...sarah, team: null }])),
      // The pasted reply makes her again; validation names her ref, and the repair uses it.
      out(
        answer([
          { ...sarah, personRef: "$person:2", team: null },
          { ...cert, ownerPersonId: "$person:2" },
        ]),
      ),
      out(answer([{ ...cert, ownerPersonId: "$person:1" }])),
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text: "add Sarah Lee as a contact",
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            text: "Sarah will send the signed certificate for PAY-2 by Friday.",
            source: "teams",
            today: TODAY,
          });
          const proposed = (yield* readThread(first.inboxItemId)).props.map((p) => p.payload);
          const decided = yield* (yield* Proposals).approveAll(first.inboxItemId);
          return { proposed, decided, people: yield* listPeople };
        }),
        layer,
      ),
    );
    expect(promptOf(models.calls, 1)).toContain(
      "$person:1: Sarah Lee | proposed earlier in this conversation, not added yet",
    );
    expect(promptOf(models.calls, 2)).toContain(
      "Sarah Lee is already proposed in this conversation as $person:1",
    );
    expect(r.proposed).toMatchObject([
      { kind: "create_person", ref: "$person:1" },
      { kind: "link_dependency", ownerPersonId: "$person:1" },
    ]);
    expect(r.decided.map((d) => d.status)).toEqual(["executed", "executed"]);
    expect(r.people.map((p) => p.displayName)).toEqual(["Sarah Lee"]);
  });

  test("pasted text naming bystanders adds nobody", async () => {
    const comment = {
      kind: "add_comment",
      target: "PAY-4",
      body: "Finance confirmed the export format.",
    };
    const { layer, models } = layerWith([
      out(
        answer([
          comment,
          { kind: "create_person", personRef: "$person:1", displayName: "Marco Rossi" },
        ]),
      ),
      out(answer([comment])),
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const t = yield* (yield* Intake).triage({
            text: "Hi Rick, Marco Rossi and Lena Fischer from the vendor confirmed the export format. Can you note that on PAY-4?",
            source: "email",
            senderPersonId: null,
            today: TODAY,
          });
          return (yield* readThread(t.inboxItemId)).props.map((p) => p.kind);
        }),
        layer,
      ),
    );
    expect(promptOf(models.calls, 1)).toContain("the user did not ask to add Marco Rossi");
    expect(r).toEqual(["add_comment"]);
  });
});

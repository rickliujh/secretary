import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { portableSchema } from "@/services/llm/portable";
import { snapshot } from "@/test/fixtures/intake/snapshot";
import {
  buildClassifyPrompt,
  buildItemSchema,
  fromPayload,
  type ItemOutput,
  type ItemSnapshot,
  mapItemOutput,
  NO_TEAM,
  offeredKinds,
  validateItemOutput,
} from "./classify";

const base = { rationale: "r", evidence: "e", confidence: 0.9 };
const typed: ItemSnapshot = {
  ...snapshot,
  source: "typed",
  sender: null,
  quote: "add Sarah Lee, staff engineer on the Identity team, as a contact",
  people: [
    ...snapshot.people,
    {
      id: "p-tom2",
      displayName: "Tom  Baker",
      title: null,
      team: null,
      jiraUsername: null,
      email: "tom@example.com",
    },
  ],
};
const pasted: ItemSnapshot = {
  ...snapshot,
  quote: "Omar Haddad from Treasury will approve the ledger accounts for PAY-2 by Thursday.",
};

const out = (proposals: ItemOutput["proposals"]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals,
});
const team = (extra: Record<string, unknown> = {}) => ({
  kind: "create_team",
  teamRef: "$team:1",
  name: "Identity",
  function: "Login and accounts",
  ...base,
  ...extra,
});
const sarah = (extra: Record<string, unknown> = {}) => ({
  kind: "create_person",
  personRef: "$person:1",
  displayName: "Sarah Lee",
  title: "Staff engineer",
  team: "$team:1",
  formality: "formal",
  ...base,
  ...extra,
});

describe("new contacts and teams (prompt version 14, D60)", () => {
  test("version 14 offers the kinds, refs and the rule; older snapshots replay without them", () => {
    expect(offeredKinds(typed)).toEqual(expect.arrayContaining(["create_team", "create_person"]));
    const json = JSON.stringify(portableSchema(z.toJSONSchema(buildItemSchema(typed))));
    for (const v of ['"$person:1"', '"$team:3"', `"${NO_TEAM}"`, '"personRef"', '"subjectId"'])
      expect(json).toContain(v);
    expect(buildClassifyPrompt(typed).system).toContain(
      "Propose create_person or create_team only",
    );

    const old: ItemSnapshot = { ...typed, promptVersion: 13 };
    expect(offeredKinds(old)).not.toContain("create_person");
    const oldJson = JSON.stringify(z.toJSONSchema(buildItemSchema(old)));
    for (const v of ['"$person:1"', '"personRef"', '"subjectId"', "personRef of a contact"])
      expect(oldJson).not.toContain(v);
    expect(buildClassifyPrompt(old).system).not.toContain("create_person");
  });

  test("a team and a contact in it validate and map, the contact pointing at the team's ref", () => {
    const answer = out([team(), sarah({ email: "sarah.lee@example.com", jiraUsername: "ana.b" })]);
    // ana.b is a known Jira user, but Ana Bell already has it: a duplicate by Jira user.
    expect(validateItemOutput(answer, typed).join(" ")).toContain("Ana Bell is already a contact");
    const ok = out([team(), sarah({ email: "sarah.lee@example.com" })]);
    expect(validateItemOutput(ok, typed)).toEqual([]);
    const [t, p] = mapItemOutput(ok, "", typed).map((m) => m.payload);
    expect(t).toMatchObject({ kind: "create_team", ref: "$team:1", name: "Identity" });
    expect(p).toMatchObject({
      kind: "create_person",
      ref: "$person:1",
      displayName: "Sarah Lee",
      team: "$team:1",
      email: "sarah.lee@example.com",
      profile: { formality: "formal" },
    });
  });

  test("a new team's ref in the contact's teamRef asks for it in team", () => {
    const errors = validateItemOutput(
      out([team(), sarah({ team: null, teamRef: "$team:1" })]),
      typed,
    );
    expect(errors).toEqual([
      "Proposal 2 (create_person): teamRef is only for create_team. To put Sarah Lee in the team $team:1 creates, set team to $team:1.",
    ]);
    // A leftover next to a team, or a ref nothing creates, is ignored.
    expect(validateItemOutput(out([team(), sarah({ teamRef: "$team:1" })]), typed)).toEqual([]);
    expect(validateItemOutput(out([sarah({ team: null, teamRef: "$team:2" })]), typed)).toEqual([]);
  });

  test("refs must be created in the answer, once each", () => {
    expect(validateItemOutput(out([sarah()]), typed).join(" ")).toContain(
      "team $team:1 is not created by any create_team",
    );
    const twice = validateItemOutput(out([team(), team({ name: "Accounts" }), sarah()]), typed);
    expect(twice.join(" ")).toContain("$team:1 is created twice");
    const owner = validateItemOutput(
      out([
        {
          kind: "link_dependency",
          target: "PAY-2",
          dependencyKind: "person",
          label: "approval",
          ownerPersonId: "$person:2",
          ...base,
        },
      ]),
      typed,
    );
    expect(owner.join(" ")).toContain(
      "ownerPersonId $person:2 is not created by any create_person",
    );
  });

  test("an email must look like one and a Jira user must be listed", () => {
    const errors = validateItemOutput(
      out([sarah({ team: null, email: "sarah at example", jiraUsername: "s.lee" })]),
      typed,
    ).join(" ");
    expect(errors).toContain("email sarah at example is not an email address");
    expect(errors).toContain("jiraUsername s.lee is not a known Jira user");
  });

  test("no duplicates: an existing contact by name, email or Jira user, an existing team, or twice", () => {
    const named = validateItemOutput(out([sarah({ team: null, displayName: "ana  BELL" })]), typed);
    expect(named.join(" ")).toContain("Ana Bell is already a contact (p-ana)");
    expect(named.join(" ")).toContain("use p-ana wherever this answer needs them");
    const byEmail = validateItemOutput(
      out([sarah({ team: null, displayName: "Thomas", email: "TOM@example.com" })]),
      typed,
    );
    expect(byEmail.join(" ")).toContain("Tom  Baker is already a contact (p-tom2)");
    const teamDup = validateItemOutput(out([team({ name: "platform" })]), typed);
    expect(teamDup.join(" ")).toContain("team Platform already exists (t-plat)");
    const twice = validateItemOutput(
      out([sarah({ team: null }), sarah({ team: null, personRef: "$person:2" })]),
      typed,
    );
    expect(twice.join(" ")).toContain("Sarah Lee is created twice");
  });

  test("pasted text alone adds a contact only when another proposal needs them", () => {
    const omar = {
      kind: "create_person",
      personRef: "$person:1",
      displayName: "Omar Haddad",
      ...base,
    };
    const wait = {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "person",
      label: "Approval of the ledger accounts",
      ownerPersonId: "$person:1",
      ...base,
    };
    expect(validateItemOutput(out([omar]), pasted).join(" ")).toContain(
      "the user did not ask to add Omar Haddad",
    );
    expect(validateItemOutput(out([omar, wait]), pasted)).toEqual([]);
    // A team counts as needed through a needed contact in it.
    const treasury = { ...team({ name: "Treasury" }) };
    expect(validateItemOutput(out([treasury, { ...omar, team: "$team:1" }, wait]), pasted)).toEqual(
      [],
    );
    expect(validateItemOutput(out([treasury, omar, wait]), pasted).join(" ")).toContain(
      "the user did not ask to add Treasury",
    );
    // A memory about him is no need.
    const memory = {
      kind: "remember",
      memoryKind: "fact",
      content: "Omar approves ledger accounts",
      subjectId: "$person:1",
      ...base,
    };
    expect(validateItemOutput(out([omar, memory]), pasted).join(" ")).toContain(
      "the user did not ask to add Omar Haddad",
    );
    // The user's own words in the thread may ask for it, when they name him; any
    // other instruction does not.
    const said = (instruction: string) => ({
      ...pasted,
      thread: { instructions: [instruction], decided: [], pending: [] },
    });
    expect(validateItemOutput(out([omar]), said("add omar as a contact"))).toEqual([]);
    expect(validateItemOutput(out([omar]), said("add him as a contact")).join(" ")).toContain(
      "the user did not ask to add Omar Haddad",
    );
    expect(validateItemOutput(out([omar]), said("Omarion is someone else")).join(" ")).toContain(
      "the user did not ask to add Omar Haddad",
    );
    // Typed input is the user's own (the chat's request on their behalf too).
    expect(validateItemOutput(out([omar]), { ...pasted, source: "typed" })).toEqual([]);
  });

  test("a contact or team another item of the thread proposes is used by its ref", () => {
    const earlier: ItemSnapshot = {
      ...pasted,
      threadCreates: [
        { ref: "$person:1", kind: "person", name: "Omar Haddad" },
        { ref: "$team:1", kind: "team", name: "Treasury" },
      ],
    };
    const json = JSON.stringify(z.toJSONSchema(buildItemSchema(earlier)));
    // Its ref is listed and offered; new ones of this answer take the next refs.
    expect(buildClassifyPrompt(earlier).prompt).toContain(
      "- $person:1: Omar Haddad | proposed earlier in this conversation, not added yet",
    );
    expect(json).toContain('"$person:4"');
    const wait = {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "person",
      label: "Approval",
      ownerPersonId: "$person:1",
      ...base,
    };
    expect(validateItemOutput(out([wait]), earlier)).toEqual([]);
    const again = validateItemOutput(
      out([{ kind: "create_person", personRef: "$person:2", displayName: "omar haddad", ...base }]),
      earlier,
    );
    expect(again.join(" ")).toContain(
      "Omar Haddad is already proposed in this conversation as $person:1",
    );
  });

  test("update_person moves a contact to a team, a new one, or out of theirs", () => {
    const move = (t: string) => ({ kind: "update_person", personId: "p-ana", team: t, ...base });
    const [toTeam] = mapItemOutput(out([move("t-plat")]), "", typed).map((m) => m.payload);
    expect(toTeam).toMatchObject({ changes: { team: "t-plat" } });
    const [out_] = mapItemOutput(out([move(NO_TEAM)]), "", typed).map((m) => m.payload);
    expect(out_).toMatchObject({ changes: { team: null } });
    expect(validateItemOutput(out([move("$team:1")]), typed).join(" ")).toContain(
      "team $team:1 is not created",
    );
    expect(validateItemOutput(out([team(), move("$team:1")]), typed)).toEqual([]);
    // Without a team, the change has no team field at all.
    const [plain] = mapItemOutput(
      out([{ kind: "update_person", personId: "p-ana", title: "Principal", ...base }]),
      "",
      typed,
    ).map((m) => m.payload);
    expect(plain).toMatchObject({ changes: { title: "Principal" } });
    expect("team" in (plain as { changes: object }).changes).toBe(false);
  });

  test("a memory about a contact or team gets its subject from the id", () => {
    const mem = (subjectId: string) => ({
      kind: "remember",
      memoryKind: "fact",
      content: "Prefers email",
      subjectId,
      ...base,
    });
    const payloads = mapItemOutput(
      out([sarah({ team: null }), mem("$person:1"), mem("t-plat"), mem("p-ana")]),
      "",
      typed,
    ).map((m) => m.payload);
    expect(payloads.slice(1)).toMatchObject([
      { subjectType: "person", subjectId: "$person:1" },
      { subjectType: "team", subjectId: "t-plat" },
      { subjectType: "person", subjectId: "p-ana" },
    ]);
  });

  test("stored payloads come back in the flat shape with refs renamed", () => {
    const refs = new Map([
      ["$team:4", "$team:1"],
      ["$person:7", "$person:1"],
    ]);
    expect(
      fromPayload(
        {
          kind: "create_person",
          ref: "$person:7",
          displayName: "Sarah Lee",
          title: null,
          email: null,
          jiraUsername: null,
          team: "$team:4",
          responsibilities: null,
          profile: { tone: "dry" },
          note: "Met at the offsite",
        },
        refs,
      ),
    ).toMatchObject({
      personRef: "$person:1",
      team: "$team:1",
      tone: "dry",
      note: "Met at the offsite",
    });
    expect(
      fromPayload(
        {
          kind: "update_person",
          personId: "p-ana",
          changes: { team: null },
          noteAppend: null,
        },
        refs,
      ),
    ).toMatchObject({ team: NO_TEAM });
    expect(
      fromPayload(
        {
          kind: "link_dependency",
          target: "PAY-2",
          dependencyKind: "person",
          label: "x",
          ownerPersonId: "$person:7",
          ownerTeamId: null,
          externalRef: null,
          externalUrl: null,
          mirror: false,
          expectedAt: null,
          nextFollowupAt: null,
        },
        refs,
      ),
    ).toMatchObject({ ownerPersonId: "$person:1" });
  });
});

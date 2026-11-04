/** Waits in classify_item (D46, D47): update_dependency, the Open waits list, and awayUntil. */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { snapshot } from "@/test/fixtures/intake/snapshot";
import {
  buildClassifyPrompt,
  buildItemSchema,
  CLASSIFY_PROMPT_VERSION,
  fromPayload,
  type ItemOutput,
  type ItemSnapshot,
  mapItemOutput,
  offeredKinds,
  validateItemOutput,
  type WaitCandidate,
} from "./classify";

const bobWait: WaitCandidate = {
  id: "01JWAITBOB",
  issueKey: "PAY-2",
  label: "Q3 numbers from finance",
  kind: "person",
  owner: "Ana Bell",
  ownerPersonId: "p-ana",
  ownerTeamId: null,
  externalRef: null,
  status: "waiting",
  requestedOn: "2026-09-20",
  expectedAt: "2026-09-23",
  nextFollowupAt: "2026-09-24",
  awayUntil: null,
  reasons: ["sender", "ticket"],
};
const platWait: WaitCandidate = {
  ...bobWait,
  id: "01JWAITPLAT",
  label: "Platform fix",
  kind: "incident",
  owner: "Platform",
  ownerPersonId: null,
  ownerTeamId: "t-plat",
  externalRef: "INC0012345",
  reasons: ["ticket", "wording"],
};
const withWaits: ItemSnapshot = {
  ...snapshot,
  quote: "Here are the Q3 numbers you asked for, sorry for the delay.",
  waits: [bobWait, platWait],
};
const e = { rationale: "r", evidence: "Here are the Q3 numbers", confidence: 0.9 };
const resolve = {
  kind: "update_dependency",
  dependencyId: bobWait.id,
  waitAction: "resolve",
  reply: "Ana sent the Q3 numbers",
  ...e,
};
const answer = (...proposals: Record<string, unknown>[]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals as ItemOutput["proposals"],
});
const fields = (s: ItemSnapshot) =>
  buildItemSchema(s).shape.proposals.element.shape as unknown as Record<string, z.ZodType>;
const errorsOf = (s: ItemSnapshot, ...p: Record<string, unknown>[]) =>
  validateItemOutput(answer(...p), s);

describe("update_dependency in the schema and prompt", () => {
  test("prompt version 9 or later", () => {
    expect(CLASSIFY_PROMPT_VERSION).toBeGreaterThanOrEqual(9);
  });

  test("without open waits the kind, its fields, its rule and the list are absent", () => {
    expect(offeredKinds(snapshot)).not.toContain("update_dependency");
    expect(fields(snapshot)).not.toHaveProperty("dependencyId");
    expect(fields(snapshot)).not.toHaveProperty("waitAction");
    const { system, prompt } = buildClassifyPrompt(snapshot);
    expect(system).not.toContain("update_dependency");
    expect(prompt).not.toContain("Open waits");
  });

  test("with waits: the kind, ids from the list only, the actions, the rule and the list", () => {
    expect(offeredKinds(withWaits)).toContain("update_dependency");
    const { dependencyId, waitAction } = fields(withWaits);
    if (!dependencyId || !waitAction) throw new Error("fields missing");
    expect(dependencyId.parse(bobWait.id)).toBe(bobWait.id);
    expect(dependencyId.safeParse("01JOTHER").success).toBe(false);
    expect(waitAction.safeParse("close").success).toBe(false);
    const { system, prompt } = buildClassifyPrompt(withWaits);
    expect(system).toContain(
      'resolve when what was waited for arrived or is no longer needed ("Bob sent the numbers")',
    );
    expect(system).toContain("Never propose link_dependency for a wait that list already has");
    expect(prompt).toContain(
      "- 01JWAITBOB: PAY-2 waits on Q3 numbers from finance [owner Ana Bell | waiting | asked 2026-09-20 | expected 2026-09-23 | next chase 2026-09-24] (sender, ticket)",
    );
    expect(prompt).toContain("INC0012345");
  });

  test("snapshots from before keep their Open dependencies line; new ones list waits instead", () => {
    const old: ItemSnapshot = {
      ...snapshot,
      dependencies: [{ issueKey: "PAY-2", label: "Platform fix", status: "open" }],
    };
    expect(buildClassifyPrompt(old).prompt).toContain("- PAY-2 waits on Platform fix (open)");
    expect(buildClassifyPrompt({ ...old, waits: [platWait] }).prompt).not.toContain(
      "Open dependencies:",
    );
  });
});

describe("validating and mapping update_dependency", () => {
  test("a resolve maps to the canonical payload with code's ticket, label and channel, and back", () => {
    expect(errorsOf(withWaits, resolve)).toEqual([]);
    const [m] = mapItemOutput(answer(resolve), withWaits.quote, withWaits);
    expect(m?.payload).toEqual({
      kind: "update_dependency",
      dependencyId: bobWait.id,
      action: "resolve",
      summary: "Ana sent the Q3 numbers",
      expectedAt: null,
      nextFollowupAt: null,
      channel: "teams",
      issueKey: "PAY-2",
      label: "Q3 numbers from finance",
      logged: true,
    });
    if (!m) throw new Error("no proposal");
    expect(fromPayload(m.payload)).toEqual({
      kind: "update_dependency",
      dependencyId: bobWait.id,
      waitAction: "resolve",
      reply: "Ana sent the Q3 numbers",
      expectedAt: null,
      nextFollowupAt: null,
    });
  });

  test("a partial answer logs a reply with the new date", () => {
    const reply = {
      ...resolve,
      waitAction: "log_reply",
      reply: "Half of it now, the rest by Friday",
      expectedAt: "2026-09-25",
    };
    expect(errorsOf(withWaits, reply)).toEqual([]);
    expect(mapItemOutput(answer(reply), "", withWaits)[0]?.payload).toMatchObject({
      action: "log_reply",
      expectedAt: "2026-09-25",
    });
  });

  test("needs a listed wait and an action; once per wait; a reschedule needs a date; no past dates", () => {
    expect(errorsOf(withWaits, { ...resolve, waitAction: null })).toContain(
      "Proposal 1 (update_dependency): update_dependency needs waitAction.",
    );
    expect(errorsOf(withWaits, { ...resolve, dependencyId: "01JOTHER" })).toContain(
      "Proposal 1 (update_dependency): dependencyId 01JOTHER is not one of the open waits.",
    );
    expect(errorsOf(withWaits, resolve, { ...resolve, waitAction: "log_reply" })).toContain(
      `Proposal 2 (update_dependency): wait ${bobWait.id} is updated twice; propose one change for it.`,
    );
    expect(errorsOf(withWaits, { ...resolve, waitAction: "reschedule" })).toContain(
      "Proposal 1 (update_dependency): a reschedule needs expectedAt or nextFollowupAt.",
    );
    expect(
      errorsOf(withWaits, { ...resolve, waitAction: "reschedule", nextFollowupAt: "2026-09-01" }),
    ).toContain(
      "Proposal 1 (update_dependency): nextFollowupAt 2026-09-01 is in the past (today is 2026-09-24).",
    );
    expect(
      errorsOf(withWaits, { ...resolve, waitAction: "reschedule", expectedAt: "soon" }),
    ).toContain("Proposal 1 (update_dependency): expectedAt must be YYYY-MM-DD or null.");
  });

  test("no new link_dependency for a wait the list already has", () => {
    const dup = {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "incident",
      label: "Platform fix",
      ownerTeamId: "t-plat",
      externalRef: "INC0012345",
      ...e,
    };
    expect(errorsOf(withWaits, dup)).toContain(
      `Proposal 1 (link_dependency): open wait ${platWait.id} already tracks Platform fix on PAY-2; use update_dependency for it, or leave this out.`,
    );
    // Another owner on the same ticket is a new wait.
    expect(
      errorsOf(withWaits, { ...dup, ownerTeamId: null, externalRef: "INC0099999", label: "DNS" }),
    ).toEqual([]);
  });

  test("the same owner and ticket with a different ask is a new wait", () => {
    const ask = {
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "person",
      ownerPersonId: "p-ana",
      externalRef: null,
      ...e,
    };
    // Ana already owes the Q3 numbers; a sign-off from her is something else.
    expect(errorsOf(withWaits, { ...ask, label: "Sign-off on the vendor contract" })).toEqual([]);
    // Her name in the label is not a shared subject.
    expect(errorsOf(withWaits, { ...ask, label: "Ana Bell to approve access" })).toEqual([]);
    // The same thing again is still turned away.
    expect(errorsOf(withWaits, { ...ask, label: "Finance numbers for Q3" })).toContain(
      `Proposal 1 (link_dependency): open wait ${bobWait.id} already tracks Q3 numbers from finance on PAY-2; use update_dependency for it, or leave this out.`,
    );
    // The team's wait: another incident number is another wait, the same one is not.
    const inc = { ...ask, dependencyKind: "incident", ownerPersonId: null, ownerTeamId: "t-plat" };
    expect(
      errorsOf(withWaits, { ...inc, label: "Platform fix", externalRef: "INC0099999" }),
    ).toEqual([]);
    expect(
      errorsOf(withWaits, { ...inc, label: "Fix for INC0012345", externalRef: "INC0012345" }),
    ).toContain(
      `Proposal 1 (link_dependency): open wait ${platWait.id} already tracks Platform fix on PAY-2; use update_dependency for it, or leave this out.`,
    );
  });
});

describe("awayUntil on update_person (D47)", () => {
  const ooo = {
    kind: "update_person",
    personId: "p-ana",
    awayUntil: "2026-10-14",
    ...e,
  };

  test("the field, the rule, and the away date shown on the person", () => {
    expect(fields(snapshot)).toHaveProperty("awayUntil");
    const { system, prompt } = buildClassifyPrompt({
      ...snapshot,
      people: snapshot.people.map((p) =>
        p.id === "p-tom" ? { ...p, awayUntil: "2026-10-01" } : p,
      ),
    });
    expect(system).toContain("When the input is an out-of-office or leave notice");
    // Prompt version 10: "until" a day is still away; "back on" a day is not (D47).
    expect(CLASSIFY_PROMPT_VERSION).toBeGreaterThanOrEqual(10);
    expect(system).toContain(
      'so awayUntil is that day ("out of office until 14 Oct" gives 14 Oct)',
    );
    expect(system).toContain('so awayUntil is the day before it ("back on 14 Oct" gives 13 Oct)');
    expect(fields(snapshot).awayUntil?.description).toContain(
      'the day itself for "until" a day, the day before for "back on" a day',
    );
    expect(prompt).toContain("- p-tom: Tom Kay | Network | jira tom.k | away until 2026-10-01");
  });

  test("maps into the person's changes and back", () => {
    expect(errorsOf(snapshot, ooo)).toEqual([]);
    const [m] = mapItemOutput(answer(ooo), "", snapshot);
    expect(m?.payload).toEqual({
      kind: "update_person",
      personId: "p-ana",
      changes: { awayUntil: "2026-10-14" },
      noteAppend: null,
    });
    if (!m) throw new Error("no proposal");
    expect(fromPayload(m.payload)).toMatchObject({ awayUntil: "2026-10-14" });
  });

  test("a real date, not in the past and at most 180 days ahead", () => {
    expect(errorsOf(snapshot, { ...ooo, awayUntil: "2026-09-31" })).toContain(
      "Proposal 1 (update_person): awayUntil 2026-09-31 is not a real date; use YYYY-MM-DD.",
    );
    expect(errorsOf(snapshot, { ...ooo, awayUntil: "2026-09-20" })).toContain(
      "Proposal 1 (update_person): awayUntil 2026-09-20 is in the past (today is 2026-09-24).",
    );
    expect(errorsOf(snapshot, { ...ooo, awayUntil: "2027-10-14" })).toContain(
      "Proposal 1 (update_person): awayUntil 2027-10-14 is more than 180 days away; check the year.",
    );
  });
});

describe("reading a line by what it names (prompt version 18, D69)", () => {
  const others = [
    { summary: "A story for the Podman 6.0.2 install failure", quote: "Create a Story" },
  ];
  const thread = (noteLine: boolean) => ({
    instructions: [],
    decided: [],
    pending: [],
    others,
    ...(noteLine ? { noteLine: true as const } : {}),
  });
  const at = (promptVersion: number, s: Partial<ItemSnapshot> = {}) =>
    buildClassifyPrompt({ ...withWaits, promptVersion, ...s });
  const NOTE_LINE =
    "The input is a later line of the user's daily note, put in this conversation; it may be about other work. Read it against every candidate issue and open wait by what it names, and act on this conversation's tickets only when the line is about them.";
  const PICK =
    "When more than one wait could be meant, pick the one whose ticket, label or reference the input names. Never pick a wait because this conversation made or acts on its ticket when the input names something else.";
  const SAYS =
    'An add_comment, or an update_dependency reply, says what the input says: something the input asks to be done ("notify the owner", "close the incident") is not written as done.';
  const REFERENCES =
    "References found by code in this input and the earlier items of this conversation:";
  const RESOLVE_IT = 'Use them to work out what "it", "that ticket" or "the issue" refers to.';

  test("the version is 18", () => {
    expect(CLASSIFY_PROMPT_VERSION).toBe(18);
  });

  test("(a) the note line sentence leads the earlier items only for a note line", () => {
    const note = at(18, { thread: thread(true) }).prompt;
    expect(note).toContain(
      `## Earlier in this conversation (context only)\nThe other items in this thread, oldest first. ${NOTE_LINE} Do not act on them unless`,
    );
    expect(note).not.toContain(RESOLVE_IT);
    expect(note).toContain(REFERENCES);
    const typed = at(18, { thread: thread(false) }).prompt;
    expect(typed).not.toContain(NOTE_LINE);
    expect(typed).toContain(RESOLVE_IT);
    expect(typed).toContain("References found by code: issues");
  });

  test("(b) the wait rule with open waits; (c) the comment rule always", () => {
    expect(at(18).system).toContain(PICK);
    expect(at(18).system).toContain(SAYS);
    const noWaits = at(18, { waits: [] }).system;
    expect(noWaits).not.toContain(PICK);
    // Without waits update_dependency is not offered, so the rule names comments only.
    expect(noWaits).not.toContain("update_dependency");
    expect(noWaits).toContain(SAYS.replace(", or an update_dependency reply,", ""));
  });

  test("version 17 renders as before, the note line flag included", () => {
    const old = at(17, { thread: thread(true) });
    for (const text of [NOTE_LINE, PICK, SAYS, REFERENCES]) {
      expect(old.system).not.toContain(text);
      expect(old.prompt).not.toContain(text);
    }
    expect(old.prompt).toContain(RESOLVE_IT);
    expect(old.system).toContain(
      "Never propose link_dependency for a wait that list already has; update it instead.\n",
    );
    expect(old.system).toContain(
      "When nothing should change on the ticket, propose nothing for it.\n",
    );
  });
});

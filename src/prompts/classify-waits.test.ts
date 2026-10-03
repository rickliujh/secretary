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
  test("prompt version 9", () => {
    expect(CLASSIFY_PROMPT_VERSION).toBe(9);
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
    expect(system).toContain("awayUntil is the working day before it");
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

/** Story points in classify_item (prompt version 12, D55): fields, rules, checks and mapping. */
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
  validateItemOutput,
} from "./classify";

const withScale: ItemSnapshot = {
  ...snapshot,
  quote:
    "We need a story under the billing migration epic to export credit notes. PAY-2 is more like a 5.",
  pointScale: [1, 2, 3, 5, 8],
  candidates: snapshot.candidates.map((c) => (c.key === "PAY-2" ? { ...c, storyPoints: 3 } : c)),
};
const e = { rationale: "r", evidence: "e", confidence: 0.9 };
const answer = (...proposals: Record<string, unknown>[]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals as ItemOutput["proposals"],
});
const story = {
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary: "Export credit notes to the ledger",
  epic: "PAY-1",
  ...e,
};
const fields = (s: ItemSnapshot) =>
  buildItemSchema(s).shape.proposals.element.shape as unknown as Record<string, z.ZodType>;

describe("the schema and the prompt", () => {
  test("version 12 or later; older snapshots (no scale) have no points fields and an unchanged prompt", () => {
    expect(CLASSIFY_PROMPT_VERSION).toBeGreaterThanOrEqual(12);
    expect(fields(snapshot)).not.toHaveProperty("storyPoints");
    expect(fields(snapshot)).not.toHaveProperty("pointsSource");
    expect(buildClassifyPrompt(snapshot).system).not.toContain("Story points");
  });

  test("with a scale: text points, a source enum, the rule and the scale", () => {
    const f = fields(withScale);
    expect(f.storyPoints?.parse("3")).toBe("3");
    expect(f.pointsSource?.parse("estimated")).toBe("estimated");
    const { system, prompt } = buildClassifyPrompt(withScale);
    expect(system).toContain("Never estimate an existing ticket");
    expect(system).toContain("suggest points: a value from the Story point scale");
    expect(prompt).toContain(
      "Story point scale (the values the team's tickets use): 1, 2, 3, 5, 8",
    );
    expect(prompt).toContain("- PAY-2 [Story, In Progress, epic PAY-1, assignee ana.b, 3 points]");
  });

  test("an empty scale offers only stated points and says not to estimate", () => {
    const s = { ...withScale, pointScale: [] };
    expect(fields(s).pointsSource?.safeParse("estimated").success).toBe(false);
    expect(fields(s).pointsSource?.parse("stated")).toBe("stated");
    expect(buildClassifyPrompt(s).system).toContain("There is no story point scale yet");
    expect(buildClassifyPrompt(s).prompt).not.toContain("Story point scale");
  });
});

describe("validation and mapping", () => {
  test("a suggestion on a new ticket maps as estimated", () => {
    const out = answer({ ...story, storyPoints: "5", pointsSource: "estimated" });
    expect(validateItemOutput(out, withScale)).toEqual([]);
    expect(mapItemOutput(out, "", withScale)[0]?.payload).toMatchObject({
      storyPoints: 5,
      storyPointsEstimated: true,
    });
  });

  test("an estimate outside the scale goes to repair", () => {
    const out = answer({ ...story, storyPoints: "4", pointsSource: "estimated" });
    expect(validateItemOutput(out, withScale)).toEqual([
      "Proposal 1 (create_issue): an estimate must be one of the scale's values (1, 2, 3, 5, 8), not 4.",
    ]);
  });

  test("stated points must be in the input", () => {
    const out = answer({ ...story, storyPoints: "13", pointsSource: "stated" });
    expect(validateItemOutput(out, withScale)[0]).toContain(
      "storyPoints 13 is not given as story points",
    );
  });

  test("an update sets stated points; an estimate on an existing ticket is refused", () => {
    const update = { kind: "update_issue", target: "PAY-2", ...e };
    const stated = answer({ ...update, storyPoints: "5", pointsSource: "stated" });
    expect(validateItemOutput(stated, withScale)).toEqual([]);
    expect(mapItemOutput(stated, "", withScale)[0]?.payload).toEqual({
      kind: "update_issue",
      target: "PAY-2",
      changes: { storyPoints: 5 },
    });
    const estimated = answer({ ...update, storyPoints: "5", pointsSource: "estimated" });
    expect(validateItemOutput(estimated, withScale).join(" ")).toContain(
      "never estimate an existing ticket",
    );
  });

  test("an Epic gets no points", () => {
    const epic = {
      ...story,
      issueType: "Epic",
      epic: null,
      storyPoints: "5",
      pointsSource: "stated",
    };
    expect(validateItemOutput(answer(epic), withScale)).toContain(
      "Proposal 1 (create_issue): an Epic does not get story points; leave storyPoints empty.",
    );
    const update = answer({
      kind: "update_issue",
      target: "PAY-1",
      storyPoints: "5",
      pointsSource: "stated",
      ...e,
    });
    expect(validateItemOutput(update, withScale).join(" ")).toContain("an Epic does not get");
  });

  test("a small ask without stated points gets the default; stated points win", () => {
    const home: ItemSnapshot = {
      ...withScale,
      quote: "Can you send me the Q3 numbers by Friday? It's a 2-pointer at most.",
      smallAsks: {
        projectKey: "OPS",
        label: "small-ask",
        joinSprint: true,
        issueTypes: ["Task"],
        defaultType: "Task",
        defaultPoints: 1,
      },
    };
    const ask = {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Ana the Q3 numbers",
      ...e,
    };
    const suggested = answer({ ...ask, storyPoints: "3", pointsSource: "estimated" });
    expect(validateItemOutput(suggested, home)).toEqual([]);
    expect(mapItemOutput(suggested, "", home)[0]?.payload).toMatchObject({
      smallAsk: true,
      storyPoints: 1,
      storyPointsEstimated: false,
    });
    const stated = answer({ ...ask, storyPoints: "2", pointsSource: "stated" });
    expect(mapItemOutput(stated, "", home)[0]?.payload).toMatchObject({ storyPoints: 2 });
    // Without a default the suggestion stays a suggestion.
    const noDefault = {
      ...home,
      smallAsks: { ...(home.smallAsks as object), defaultPoints: null },
    };
    expect(mapItemOutput(suggested, "", noDefault as ItemSnapshot)[0]?.payload).toMatchObject({
      storyPoints: 3,
      storyPointsEstimated: true,
    });
  });
});

describe("revisions (D22)", () => {
  test("stored points return in the output shape and validate when kept", () => {
    const [m] = mapItemOutput(
      answer({ ...story, storyPoints: "5", pointsSource: "estimated" }),
      "",
      withScale,
    );
    if (!m) throw new Error("no proposal");
    const shape = fromPayload(m.payload);
    expect(shape).toMatchObject({ storyPoints: "5", pointsSource: "estimated" });
    // The user changed it to 13 in the edit dialog: it comes back as stated and stays valid.
    const edited = fromPayload({
      ...m.payload,
      storyPoints: 13,
      storyPointsEstimated: false,
    } as never);
    expect(edited).toMatchObject({ storyPoints: "13", pointsSource: "stated" });
    const revision: ItemSnapshot = {
      ...withScale,
      thread: { instructions: ["make the summary shorter"], decided: [], pending: [edited ?? {}] },
    };
    expect(validateItemOutput(answer({ ...edited, ...e }), revision)).toEqual([]);
    // Without points the shape has no points fields.
    expect(fromPayload({ ...m.payload, storyPoints: null } as never)).not.toHaveProperty(
      "storyPoints",
    );
  });

  test("a pending create's estimate does not let an update pass as stated", () => {
    const revision: ItemSnapshot = {
      ...withScale,
      quote: "We need a story for credit notes.",
      thread: {
        instructions: ["also fix PAY-2"],
        decided: [],
        pending: [{ ...story, storyPoints: "8", pointsSource: "estimated" }],
      },
    };
    const update = answer({
      kind: "update_issue",
      target: "PAY-2",
      storyPoints: "8",
      pointsSource: "stated",
      ...e,
    });
    expect(validateItemOutput(update, revision).join(" ")).toContain(
      "storyPoints 8 is not given as story points",
    );
  });

  test("points the user cleared stay cleared on a revision, with no estimate or default", () => {
    const home: ItemSnapshot = {
      ...withScale,
      quote: "Can you send me the Q3 numbers by Friday?",
      smallAsks: {
        projectKey: "OPS",
        label: "small-ask",
        joinSprint: true,
        issueTypes: ["Task"],
        defaultType: "Task",
        defaultPoints: 1,
      },
    };
    const ask = {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Ana the Q3 numbers",
      ...e,
    };
    const [m] = mapItemOutput(answer(ask), "", home);
    if (m?.payload.kind !== "create_issue") throw new Error("no create");
    expect(m.payload.storyPoints).toBe(1);
    // The user empties the points in the edit dialog.
    const shape = fromPayload({ ...m.payload, storyPoints: null, storyPointsCleared: true });
    expect(shape).toMatchObject({ pointsCleared: true });
    expect(shape).not.toHaveProperty("storyPoints");
    const revision: ItemSnapshot = {
      ...home,
      thread: { instructions: ["make it due Monday"], decided: [], pending: [shape ?? {}] },
    };
    expect(buildClassifyPrompt(revision).system).toContain("pointsCleared true");
    // The model returns it without points: no default comes back.
    const back = answer({ ...ask, dueDate: "2026-09-28" });
    expect(validateItemOutput(back, revision)).toEqual([]);
    expect(mapItemOutput(back, "", revision)[0]?.payload).toMatchObject({
      storyPoints: null,
      storyPointsCleared: true,
    });
    // An estimate is refused; a number the user's instructions give ends the clear.
    expect(
      validateItemOutput(
        answer({ ...ask, storyPoints: "2", pointsSource: "stated" }),
        revision,
      ).join(" "),
    ).toContain("the user cleared this ticket's story points");
    const told: ItemSnapshot = {
      ...revision,
      thread: { decided: [], pending: [shape ?? {}], instructions: ["make it 2 points"] },
    };
    const stated = answer({ ...ask, storyPoints: "2", pointsSource: "stated" });
    expect(validateItemOutput(stated, told)).toEqual([]);
    expect(mapItemOutput(stated, "", told)[0]?.payload).toMatchObject({
      storyPoints: 2,
      storyPointsCleared: false,
    });
  });

  test("an update that clears points keeps the clear when the model returns it without", () => {
    const shape = fromPayload({
      kind: "update_issue",
      target: "PAY-2",
      changes: { storyPoints: null },
    });
    expect(shape).toMatchObject({ pointsCleared: true });
    const revision: ItemSnapshot = {
      ...withScale,
      thread: { instructions: ["thanks"], decided: [], pending: [shape ?? {}] },
    };
    const back = answer({ kind: "update_issue", target: "PAY-2", ...e });
    expect(validateItemOutput(back, revision)).toEqual([]);
    expect(mapItemOutput(back, "", revision)[0]?.payload).toEqual({
      kind: "update_issue",
      target: "PAY-2",
      changes: { storyPoints: null },
    });
  });

  test("a small ask's estimate is not checked when the default replaces it", () => {
    const home: ItemSnapshot = {
      ...withScale,
      quote: "Can you send me the Q3 numbers by Friday?",
      smallAsks: {
        projectKey: "OPS",
        label: "small-ask",
        joinSprint: true,
        issueTypes: ["Task"],
        defaultType: "Task",
        defaultPoints: 1,
      },
    };
    const offScale = answer({
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Ana the Q3 numbers",
      storyPoints: "4",
      pointsSource: "estimated",
      ...e,
    });
    expect(validateItemOutput(offScale, home)).toEqual([]);
    const noDefault = {
      ...home,
      smallAsks: { ...(home.smallAsks as object), defaultPoints: null },
    };
    expect(validateItemOutput(offScale, noDefault as ItemSnapshot)).not.toEqual([]);
  });
});

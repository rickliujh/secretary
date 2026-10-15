/** Story points in classify_item (prompt version 12, D55): fields, rules, checks and mapping. */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { splitMessage } from "@/services/intake/thread";
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

  test("a teammate's new estimate is proposed; an answer is acted on, not confirmed (eval, 2026-10-15)", () => {
    const { system } = buildClassifyPrompt(withScale);
    expect(system).toContain("including one from a teammate in a message the user pasted");
    expect(system).toContain("do not ask first, because the user approves every proposal");
    expect(system).not.toContain("Once the user has answered your question");
    const answered: ItemSnapshot = {
      ...withScale,
      thread: { instructions: ["3"], decided: [], pending: [], questions: ["How many points?"] },
    };
    expect(buildClassifyPrompt(answered).system).toContain(
      "Once the user has answered your question, act on the answer",
    );
    const older = { ...answered, promptVersion: 11, pointScale: undefined };
    expect(buildClassifyPrompt(older).system).not.toContain("Once the user has answered");
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

  test("fields the ticket already has are dropped from an update (eval, 2026-10-15)", () => {
    const s: ItemSnapshot = {
      ...withScale,
      candidates: withScale.candidates.map((c) =>
        c.key === "PAY-2" ? { ...c, priority: "High", dueDate: "2026-10-30" } : c,
      ),
    };
    const out = answer({
      kind: "update_issue",
      target: "PAY-2",
      summary: "Export invoices to the new ledger",
      priority: "High",
      dueDate: "2026-10-30",
      assignee: "ana.b",
      storyPoints: "5",
      pointsSource: "stated",
      ...e,
    });
    expect(validateItemOutput(out, s)).toEqual([]);
    expect(mapItemOutput(out, "", s)[0]?.payload).toEqual({
      kind: "update_issue",
      target: "PAY-2",
      changes: { storyPoints: 5 },
    });
  });

  test("an update that changes nothing is left out, not repeated or asked about", () => {
    const out = answer({
      kind: "update_issue",
      target: "PAY-2",
      assignee: "ana.b",
      storyPoints: "3",
      pointsSource: "stated",
      ...e,
    });
    const errors = validateItemOutput(out, withScale);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('PAY-2 already has assignee "ana.b", storyPoints 3');
    expect(errors[0]).toContain("Leave it out, and do not ask the user to confirm");
    // What the repair asks for passes: no proposals, and a question that says so.
    expect(
      validateItemOutput({ ...answer(), question: "PAY-2 already has 3 story points." }, withScale),
    ).toEqual([]);
  });

  test("stray punctuation in the points is ignored; text that is no number drops them", () => {
    const update = { kind: "update_issue", target: "PAY-2", ...e };
    const colon = answer({ ...update, storyPoints: ": 5", pointsSource: "stated" });
    expect(validateItemOutput(colon, withScale)).toEqual([]);
    expect(mapItemOutput(colon, "", withScale)[0]?.payload).toMatchObject({
      changes: { storyPoints: 5 },
    });
    const created = answer({ ...story, storyPoints: ":", pointsSource: "stated" });
    expect(validateItemOutput(created, withScale)).toEqual([]);
    expect(mapItemOutput(created, "", withScale)[0]?.payload).toMatchObject({
      storyPoints: null,
      storyPointsEstimated: false,
    });
    const words = answer({ ...story, storyPoints: "not sure", pointsSource: "(none)" });
    expect(validateItemOutput(words, withScale)).toEqual([]);
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

describe("the user's own words state points (answers, 2026-10-15)", () => {
  const asked: ItemSnapshot = {
    ...withScale,
    quote: "What are the story points on PAY-2? Can you set them?",
  };
  const turn = (
    instructions: string[],
    pending: Record<string, unknown>[] = [],
    more: Partial<ItemSnapshot> = {},
  ): ItemSnapshot => ({
    ...asked,
    ...more,
    thread: { instructions, decided: [], pending },
  });
  /** A thread whose input does not mention points (pasted, so not the user's words). */
  const plain = (instructions: string[], questions?: string[]): ItemSnapshot => ({
    ...withScale,
    quote: "Ana: PAY-2 needs a look before the release.",
    thread: { instructions, decided: [], pending: [], ...(questions ? { questions } : {}) },
  });
  const update = (points: string) =>
    answer({
      kind: "update_issue",
      target: "PAY-2",
      storyPoints: points,
      pointsSource: "stated",
      ...e,
    });
  const created = (points: string) =>
    answer({ ...story, storyPoints: points, pointsSource: "stated" });
  const notStated = (points: number) => `storyPoints ${points} is not given as story points`;

  test('the reported flow: a typed "why no story points?", then "1" answering the question', () => {
    const typed = {
      source: "typed",
      ownInput: true,
      quote: "why does PAY-2 have no story points?",
    };
    // Without the answer the number is the model's own: refused, and it is told to ask.
    const refused = validateItemOutput(update("1"), { ...asked, ...typed }).join(" ");
    expect(refused).toContain(notStated(1));
    expect(refused).toContain("ask the user for the number in question");
    const answered: ItemSnapshot = {
      ...asked,
      ...typed,
      thread: {
        instructions: ["1"],
        decided: [],
        pending: [],
        questions: ["How many story points should PAY-2 have?"],
      },
    };
    expect(validateItemOutput(update("1"), answered)).toEqual([]);
    expect(mapItemOutput(update("1"), "", answered)[0]?.payload).toEqual({
      kind: "update_issue",
      target: "PAY-2",
      changes: { storyPoints: 1 },
    });
  });

  test("a bare number or a short set/make form is about points by its form", () => {
    for (const words of ["2", "2 points", "2.", "set it to 2", "make it a 2", "make PAY-2 a 2"])
      expect({ words, errors: validateItemOutput(update("2"), plain([words])) }).toEqual({
        words,
        errors: [],
      });
  });

  test("an answer to a question about points, or points named in the user's words, makes any number points", () => {
    const answer2 = ["go with 2 I think"];
    expect(validateItemOutput(update("2"), plain(answer2)).join(" ")).toContain(notStated(2));
    expect(
      validateItemOutput(update("2"), plain(answer2, ["How many story points should PAY-2 get?"])),
    ).toEqual([]);
    // A question about something else does not.
    expect(
      validateItemOutput(update("2"), plain(answer2, ["Which sprint should PAY-2 go to?"])).join(
        " ",
      ),
    ).toContain(notStated(2));
    expect(
      validateItemOutput(update("2"), plain(["let's fix the points on PAY-2", ...answer2])),
    ).toEqual([]);
  });

  test("numbers in the user's words about something else are not points", () => {
    expect(
      validateItemOutput(update("2"), plain(["send 2 reports to PAY-12"])).join(" "),
    ).toContain(notStated(2));
    expect(
      validateItemOutput(update("24"), plain(["move PAY-12 to sprint 24"])).join(" "),
    ).toContain(notStated(24));
    expect(validateItemOutput(update("5"), plain(["PAY-12 due Oct 5"])).join(" ")).toContain(
      notStated(5),
    );
  });

  test('a typed opening message is the user\'s own words: "make PAY-2 a 5", "PAY-2 should be 5 points now"', () => {
    const typed = (quote: string): ItemSnapshot => ({
      ...withScale,
      source: "typed",
      ownInput: true,
      quote,
    });
    expect(validateItemOutput(update("5"), typed("make PAY-2 a 5"))).toEqual([]);
    // Points named anywhere in their words: an un-cued number counts.
    expect(validateItemOutput(update("5"), typed("Fix the points: PAY-2 should be 5"))).toEqual([]);
    // The same words without the flag (pasted, or written by the chat) need a cue.
    expect(
      validateItemOutput(update("5"), {
        ...typed("Fix the points: PAY-2 should be 5"),
        ownInput: false,
      }).join(" "),
    ).toContain(notStated(5));
  });

  test("«…» values inside typed input and instructions are not the user's words", () => {
    const typed: ItemSnapshot = {
      ...withScale,
      source: "typed",
      ownInput: true,
      quote: "Create a story: Dana wrote «can you send me two reports by Friday?»",
    };
    expect(validateItemOutput(created("2"), typed).join(" ")).toContain(notStated(2));
    // A cue inside the value still counts, as it does in any pasted text.
    const cued = { ...typed, quote: "Create a story: Dana wrote «it's a 2-pointer»" };
    expect(validateItemOutput(created("2"), cued)).toEqual([]);
    // In an instruction too.
    expect(validateItemOutput(update("13"), plain(["set PAY-2 to «13»"])).join(" ")).toContain(
      notStated(13),
    );
    expect(validateItemOutput(update("2"), plain(["Dana says «it's a 2-pointer»"]))).toEqual([]);
  });

  test("an inline reply «13» (D56) with no points cue is not stated, even when points are the topic", () => {
    // The instruction as the message box splits it: the paste shares the typed line.
    const { instruction } = splitMessage(
      [
        { type: "typed", text: "make it " },
        { type: "pasted", text: "13" },
      ],
      false,
      true,
    );
    expect(instruction).toBe("make it «13»");
    const asked = ["How many story points should PAY-2 get?"];
    expect(validateItemOutput(update("13"), plain([instruction ?? ""], asked)).join(" ")).toContain(
      notStated(13),
    );
    // The same number typed by the user answers the question.
    expect(validateItemOutput(update("13"), plain(["make it 13"], asked))).toEqual([]);
  });

  test("pasted input (any source) still needs a cue; the make forms are cues", () => {
    for (const source of ["typed", "teams", "email", "meeting", "other"]) {
      const pasted: ItemSnapshot = {
        ...withScale,
        source,
        quote: "Fix the points: PAY-2 should be 5",
      };
      expect(validateItemOutput(update("5"), pasted).join(" ")).toContain(notStated(5));
    }
    expect(validateItemOutput(update("5"), { ...withScale, quote: "make PAY-2 a 5" })).toEqual([]);
    expect(
      validateItemOutput(created("2"), {
        ...withScale,
        quote: "Can you send me two reports?",
      }).join(" "),
    ).toContain(notStated(2));
  });

  test("only the newest instruction or answer ends a clear", () => {
    const cleared = { ...story, pointsCleared: true };
    const two = created("2");
    // An older instruction's number, cued or not, does not undo the later clear.
    for (const older of ["create it, 2 reviewers needed", "create it, 2 points"])
      expect(
        validateItemOutput(two, turn([older, "make the summary shorter"], [cleared])).join(" "),
      ).toContain("the user cleared this ticket's story points");
    // Nor does typed input, which stays the same across turns.
    const typed = turn(["make the summary shorter"], [cleared], {
      source: "typed",
      ownInput: true,
      quote: "We need a story for credit notes, 2 points",
    });
    expect(validateItemOutput(two, typed).join(" ")).toContain(
      "the user cleared this ticket's story points",
    );
    // The newest one does.
    expect(validateItemOutput(two, turn(["make the summary shorter", "2"], [cleared]))).toEqual([]);
  });

  test("the per-proposal kept rules still hold", () => {
    // A pending create's estimate is no stated number, whatever else the user typed.
    const estimate = { ...story, storyPoints: "8", pointsSource: "estimated" };
    expect(validateItemOutput(update("8"), turn(["make it 1"], [estimate])).join(" ")).toContain(
      notStated(8),
    );
    // The user's own 13 on the proposal it revises is kept.
    const kept = { ...story, storyPoints: "13", pointsSource: "stated" };
    expect(
      validateItemOutput(
        answer({ ...kept, summary: "Credit notes to the ledger" }),
        turn(["shorter summary"], [kept]),
      ),
    ).toEqual([]);
  });

  test("the field descriptions and the rule say the user's words count", () => {
    const f = fields(asked);
    expect(f.pointsSource?.description).toContain('an answer "1" to your question about points');
    expect(buildClassifyPrompt(asked).system).toContain('"1" answering your question about points');
    expect(buildClassifyPrompt(asked).system).toContain(
      "When the user wants an existing ticket's points set but gives no number, ask for it in question.",
    );
  });
});

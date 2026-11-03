/**
 * The brief reads the work model (Phase 24, D61 Reads): the item the user is
 * on, what was expected by today and promises due, listed under "Your work";
 * an overdue promise must be named with its person, or the answer is repaired.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { llmCalls, workItems } from "@/db/schema";
import { type BriefFacts, buildBriefPrompt, isEmpty, validateBrief } from "@/prompts/brief";
import { query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import { EVAL_CASES } from "@/test/eval/cases";
import { seedWorkItem } from "@/test/eval/work-seed";
import { promptOf } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { briefHash, generateBrief } from "./brief";

// Thursday 24 September 2026, mid-morning.
const NOW = new Date("2026-09-24T09:00:00.000Z");

const cert = EVAL_CASES.find((c) => c.workItem)?.workItem;
if (!cert) throw new Error("no cert case");
/** The promise to Dana was due on Tuesday: overdue. */
const overdue = {
  ...cert,
  commitments: [{ what: "an ETA for the cert renewal", to: "dana", dueOn: "2026-09-22" }],
};

const facts = (work: BriefFacts["work"]): BriefFacts => ({
  today: "2026-09-24",
  since: null,
  outputLanguage: "English",
  changed: [],
  topFocus: [],
  dueSoon: [],
  overdueDependencies: [],
  followupsDue: [],
  waitingOnMe: [],
  pendingProposals: 0,
  ...(work ? { work } : {}),
});

describe("the brief's work facts", () => {
  test("an overdue promise must be named with its person; a promise due today need not", () => {
    const f = facts({
      current: null,
      expected: [],
      commitments: [
        { item: "Cert", what: "an ETA", to: "Dana Reyes", dueOn: "2026-09-22" },
        { item: "Cert", what: "the numbers", to: "Ana Bell", dueOn: "2026-09-24" },
      ],
    });
    const sections = { changed: "", doFirst: "- Send the cert ETA.", chase: "" };
    expect(validateBrief(sections, f)).toEqual([
      "Mention each overdue promise, naming the person it was made to: an ETA (to Dana Reyes, due 2026-09-22).",
    ]);
    expect(
      validateBrief({ ...sections, doFirst: "- Send Dana the cert ETA, overdue." }, f),
    ).toEqual([]);
    expect(isEmpty(f)).toBe(false);
    expect(isEmpty(facts({ current: null, expected: [], commitments: [] }))).toBe(true);
    // A brief without the work model reads as before.
    expect(buildBriefPrompt(facts(undefined)).prompt).not.toContain("Your work");
  });

  test("a promise to no one named is listed but not checked by name", () => {
    const f = facts({
      current: null,
      expected: [],
      commitments: [{ item: "Cert", what: "an ETA", to: null, dueOn: "2026-09-22" }],
    });
    expect(validateBrief({ changed: "", doFirst: "- Send the ETA.", chase: "" }, f)).toEqual([]);
    expect(buildBriefPrompt(f).prompt).toContain("Cert: promised someone an ETA, OVERDUE since");
  });

  test("a new current step alone leaves the brief fresh; a new overdue promise does not", () => {
    const work = (step: string, commitments: NonNullable<BriefFacts["work"]>["commitments"]) =>
      facts({
        current: {
          name: "Cert",
          currentStep: step,
          nextExpected: { what: "Sarah sends it", on: "2026-09-25" },
        },
        expected: [],
        commitments,
      });
    const base = briefHash(work("Waiting on Platform", []));
    expect(briefHash(work("Installing the cert", []))).toBe(base);
    // Due today is listed but not owed yet; overdue changes what the brief must say.
    expect(
      briefHash(
        work("Waiting on Platform", [{ item: "Cert", what: "x", to: "Dana", dueOn: "2026-09-24" }]),
      ),
    ).toBe(base);
    expect(
      briefHash(
        work("Waiting on Platform", [{ item: "Cert", what: "x", to: "Dana", dueOn: "2026-09-22" }]),
      ),
    ).not.toBe(base);
  });

  test("generated from the db: the current item, what was expected, the overdue promise", async () => {
    const noDana = {
      changed: "- Nothing new.",
      doFirst: "- Keep going on the cert renewal (PAY-12), then PAY-2.",
      chase: "- Sarah for the cert.",
    };
    const withDana = {
      ...noDana,
      doFirst: `${noDana.doFirst}\n- Send Dana Reyes the cert ETA: it is overdue.`,
    };
    const { layer, models } = intakeTestLayer({ "std-m": [out(noDana), out(withDana)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const sarah = yield* createPerson({ displayName: "Sarah Kim" });
          const dana = yield* createPerson({ displayName: "Dana Reyes" });
          const id = yield* seedWorkItem(overdue, { sarah, dana });
          yield* query((d) =>
            d.update(workItems).set({ current: true }).where(eq(workItems.id, id)),
          );
          const brief = yield* generateBrief(NOW);
          const calls = yield* query((d) => d.select().from(llmCalls).all());
          return { brief, calls };
        }),
        layer,
      ),
    );
    const prompt = promptOf(models.calls, 0);
    expect(prompt).toContain("## Your work (the secretary's record)");
    expect(prompt).toContain(
      "- On now: Renew the payment gateway cert. Now: Waiting on Platform (PLAT-812) to issue the new cert; Sarah is getting it. Next: Sarah sends the new cert (2026-09-23)",
    );
    expect(prompt).toContain(
      "- Renew the payment gateway cert: Sarah sends the new cert was expected on 2026-09-23, not seen yet",
    );
    expect(prompt).toContain(
      "- Renew the payment gateway cert: promised Dana Reyes an ETA for the cert renewal, OVERDUE since 2026-09-22",
    );
    // The first answer left Dana out, so it was repaired.
    expect(r.calls.map((c) => [c.task, c.validationOk])).toEqual([
      ["daily_brief", false],
      ["repair_output", true],
    ]);
    expect(r.brief.sections.doFirst).toContain("Dana Reyes");
  });
});

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { communications, followups } from "@/db/schema";
import { longDate } from "@/prompts/draft";
import { query } from "@/services/db";
import {
  createDependency,
  getDependency,
  requestChaseDraft,
} from "@/services/dependencies/queries";
import { createPerson, createTeam } from "@/services/directory/queries";
import type { LlmError } from "@/services/llm";
import { intakeTestLayer } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Comms } from ".";
import { createDraft, draftDetail, markSent } from "./queries";

const prompt = (calls: { prompt: unknown }[], i: number) => JSON.stringify(calls[i]?.prompt);

/** A formal, slow-to-answer Platform engineer and an incident PAY-2 waits on. */
const setup = Effect.gen(function* () {
  yield* syncOnce;
  const platform = yield* createTeam({ name: "Platform", function: "Shared infrastructure" });
  const priya = yield* createPerson({
    displayName: "Priya Shah",
    title: "SRE",
    teamId: platform,
    profile: { formality: "formal", responsiveness: "slow", language: "English" },
  });
  const depId = yield* createDependency({
    issueKey: "PAY-2",
    kind: "incident",
    label: "Platform fix",
    ownerPersonId: priya,
    externalRef: "INC0012345",
    expectedAt: "2026-09-24",
  });
  const dep = yield* getDependency(depId);
  const requested = longDate(dep?.dependency.requestedAt ?? "");
  const draftId = yield* requestChaseDraft(depId);
  return { priya, depId, draftId, requested };
});

const good = (requested: string) => ({
  subject: "",
  short: "Hello Priya, is there an update on INC0012345 for PAY-2?",
  standard: `Hello Priya, I first asked about INC0012345 on ${requested}. PAY-2 is blocked until it is fixed. Could you tell me by Friday when the fix will land?`,
});

describe("Comms.generate", () => {
  test("a chase draft is grounded in the dependency and stored with both variants", async () => {
    const run = async (answer: (requested: string) => unknown) => {
      let requested = "";
      const { layer, models } = intakeTestLayer({
        "std-m": [
          {
            get text() {
              return JSON.stringify(answer(requested));
            },
          },
        ],
      });
      const r = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const s = yield* setup;
            requested = s.requested;
            yield* (yield* Comms).generate(s.draftId, { today: "2026-09-26" });
            return { ...s, detail: yield* draftDetail(s.draftId) };
          }),
          layer,
        ),
      );
      return { r, models };
    };
    const { r, models } = await run(good);
    const d = r.detail?.draft;
    expect(d?.variants).toEqual({
      short: good(r.requested).short,
      standard: good(r.requested).standard,
    });
    expect(d?.bodyMd).toBe(good(r.requested).standard);
    expect(d).toMatchObject({ variant: "standard", subject: null, language: "English" });
    const p = prompt(models.calls, 0);
    expect(p).toContain(`First requested on ${r.requested}`);
    expect(p).toContain("INC0012345");
    expect(p).toContain("Formal: a proper greeting");
    expect(p).toContain("Chase Platform fix (INC0012345) for PAY-2");
  });

  test("a draft that leaves out the incident is repaired, then saved", async () => {
    let requested = "";
    const { layer, models } = intakeTestLayer({
      "std-m": [
        {
          get text() {
            return JSON.stringify({ ...good(requested), short: "Any news on the fix?" });
          },
        },
        {
          get text() {
            return JSON.stringify(good(requested));
          },
        },
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* setup;
          requested = s.requested;
          yield* (yield* Comms).generate(s.draftId);
          return yield* draftDetail(s.draftId);
        }),
        layer,
      ),
    );
    expect(r?.draft.variants?.short).toContain("INC0012345");
    expect(JSON.stringify(models.calls[1]?.prompt)).toContain(
      "The short variant must name INC0012345.",
    );
  });

  test("regenerating keeps every instruction; sending logs a follow-up and locks the draft", async () => {
    let requested = "";
    const reply = {
      get text() {
        return JSON.stringify(good(requested));
      },
    };
    const { layer, models } = intakeTestLayer({ "std-m": [reply, reply, reply] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* setup;
          requested = s.requested;
          const comms = yield* Comms;
          yield* comms.generate(s.draftId);
          yield* comms.generate(s.draftId, { instruction: "mention the Friday release" });
          yield* comms.generate(s.draftId, { instruction: "shorter" });
          yield* markSent(s.draftId, "2026-09-26");
          const logged = yield* query((d) =>
            d.select().from(followups).where(eq(followups.dependencyId, s.depId)).all(),
          );
          const again = yield* Effect.either(comms.generate(s.draftId));
          // The next draft to Priya sees the sent one as recent context.
          const next = yield* createDraft({
            kind: "teams",
            intent: "fyi",
            recipientPersonId: s.priya,
            notes: "The export shipped.",
          });
          const detail = yield* draftDetail(next);
          const dep = yield* getDependency(s.depId);
          return { ...s, logged, again, detail, dep };
        }),
        layer,
      ),
    );
    expect(prompt(models.calls, 2)).toContain("1. mention the Friday release\\n2. shorter");
    expect(r.logged).toHaveLength(1);
    expect(r.logged[0]).toMatchObject({ channel: "teams", communicationId: r.draftId });
    expect(r.dep?.dependency.nextFollowupAt).toBe("2026-09-30");
    expect(r.again._tag === "Left" && (r.again.left as { kind: string }).kind).toBe("sent");
    expect(r.detail?.recent.map((m) => m.id)).toEqual([r.draftId]);
  });

  test("a missing draft is a CommsError, a provider failure is an LlmError", async () => {
    const { layer } = intakeTestLayer({ "std-m": [{ status: 401, body: "bad key" }] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* setup;
          const comms = yield* Comms;
          return {
            missing: yield* Effect.either(comms.generate("nope")),
            failed: yield* Effect.either(comms.generate(s.draftId)),
            row: yield* query((d) =>
              d.select().from(communications).where(eq(communications.id, s.draftId)).get(),
            ),
          };
        }),
        layer,
      ),
    );
    expect(r.missing._tag === "Left" && r.missing.left._tag).toBe("CommsError");
    expect(r.failed._tag === "Left" && (r.failed.left as LlmError).kind).toBe("auth");
    expect(r.row?.variants).toBeNull();
  });
});

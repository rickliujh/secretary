import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { llmCalls } from "@/db/schema";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings, type TierBindings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { promptOf, testProvider } from "@/test/helpers";
import { Llm, type LlmError } from ".";
import { LlmLive } from "./live";
import { makeScriptedModels, type Scripted } from "./test";

const allTiers: TierBindings = {
  fast: { providerId: "p1", model: "fast-m" },
  standard: { providerId: "p1", model: "std-m" },
  strong: { providerId: "p1", model: "strong-m" },
};

function setup(scripts: Record<string, Scripted[]>, tiers: TierBindings = allTiers) {
  const models = makeScriptedModels(scripts);
  const deps = Layer.mergeAll(
    makeSettingsTest({ ...defaultSettings(), providers: [testProvider], tiers }),
    makeSecretsTest({ [secretNames.providerApiKey("p1")]: "key-from-keychain" }),
    DbTest,
    models.layer,
  );
  const layer = Layer.provideMerge(LlmLive, deps);
  const run = <A, E>(program: Effect.Effect<A, E, Llm | import("@/services/db").Db>) =>
    Effect.runPromise(Effect.provide(program, layer));
  const runExit = <A, E>(program: Effect.Effect<A, E, Llm | import("@/services/db").Db>) =>
    Effect.runPromiseExit(Effect.provide(program, layer));
  return { models, run, runExit };
}

const Answer = z.object({ target: z.string(), confidence: z.number() });
const candidates = ["ABC-1", "ABC-2"];
const request = {
  schema: Answer,
  prompt: "Pick one of ABC-1, ABC-2",
  validate: (v: z.infer<typeof Answer>) =>
    candidates.includes(v.target)
      ? []
      : [`target ${v.target} is not one of ${candidates.join(", ")}`],
  confidence: (v: z.infer<typeof Answer>) => v.confidence,
};

const rows = query((db) => db.select().from(llmCalls).all());

describe("Llm.object", () => {
  test("valid first answer: one call, recorded with task, tier and validation", async () => {
    const { run, models } = setup({ "std-m": [{ text: '{"target":"ABC-1","confidence":0.9}' }] });
    const { result, calls } = await run(
      Effect.gen(function* () {
        const llm = yield* Llm;
        const result = yield* llm.object("classify_item", request);
        return { result, calls: yield* rows };
      }),
    );
    expect(result.value.target).toBe("ABC-1");
    expect(result.tier).toBe("standard");
    expect(result.escalated).toBe(false);
    expect(result.repaired).toBe(false);
    expect(models.calls[0]?.apiKey).toBe("key-from-keychain");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      task: "classify_item",
      tier: "standard",
      model: "std-m",
      validationOk: true,
      ok: true,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  test("malformed output is repaired on the same model", async () => {
    const { run, models } = setup({
      "std-m": [{ text: "not json" }, { text: '{"target":"ABC-2","confidence":0.8}' }],
    });
    const { result, calls } = await run(
      Effect.gen(function* () {
        const result = yield* (yield* Llm).object("classify_item", request);
        return { result, calls: yield* rows };
      }),
    );
    expect(result.value.target).toBe("ABC-2");
    expect(result.repaired).toBe(true);
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "std-m"]);
    expect(calls.map((c) => [c.task, c.validationOk, c.repair])).toEqual([
      ["classify_item", false, false],
      ["repair_output", true, true],
    ]);
    // The repair prompt carries the previous answer and the errors.
    expect(promptOf(models.calls, 1)).toContain("failed validation");
  });

  test("out-of-candidate targets fail validation, then escalate to the stronger tier", async () => {
    const bad = { text: '{"target":"ZZZ-9","confidence":0.9}' };
    const { run, models } = setup({
      "std-m": [bad, bad],
      "strong-m": [{ text: '{"target":"ABC-1","confidence":0.9}' }],
    });
    const { result, calls } = await run(
      Effect.gen(function* () {
        const result = yield* (yield* Llm).object("classify_item", request);
        return { result, calls: yield* rows };
      }),
    );
    expect(result.value.target).toBe("ABC-1");
    expect(result.escalated).toBe(true);
    expect(result.tier).toBe("strong");
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "std-m", "strong-m"]);
    expect(calls.at(-1)).toMatchObject({ escalated: true, tier: "strong", validationOk: true });
  });

  test("when every step fails, the caller gets a schema error, never a guess", async () => {
    const bad = { text: '{"target":"ZZZ-9","confidence":0.9}' };
    const { runExit } = setup({ "std-m": [bad, bad], "strong-m": [bad] });
    const exit = await runExit(Effect.flatMap(Llm, (llm) => llm.object("classify_item", request)));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      const error = exit.cause.error as LlmError;
      expect(error.kind).toBe("schema");
      expect(error.issues?.[0]).toContain("ZZZ-9");
    }
  });

  test("tasks without escalation stop after the repair", async () => {
    const bad = { text: '{"target":"ZZZ-9","confidence":0.9}' };
    const { runExit, models } = setup({ "fast-m": [bad, bad], "std-m": [] });
    const exit = await runExit(
      Effect.flatMap(Llm, (llm) => llm.object("rerank_candidates", request)),
    );
    expect(exit._tag).toBe("Failure");
    expect(models.calls.map((c) => c.model)).toEqual(["fast-m", "fast-m"]);
  });

  test("low confidence escalates; still-low results are flagged", async () => {
    const { run } = setup({
      "std-m": [{ text: '{"target":"ABC-1","confidence":0.2}' }],
      "strong-m": [{ text: '{"target":"ABC-2","confidence":0.3}' }],
    });
    const result = await run(Effect.flatMap(Llm, (llm) => llm.object("classify_item", request)));
    expect(result.escalated).toBe(true);
    expect(result.value.target).toBe("ABC-2");
    expect(result.lowConfidence).toBe(true);
  });

  test("a single configured model serves every task without escalation", async () => {
    const { run, models } = setup(
      { "only-m": [{ text: '{"target":"ABC-1","confidence":0.1}' }] },
      { fast: null, standard: { providerId: "p1", model: "only-m" }, strong: null },
    );
    const result = await run(Effect.flatMap(Llm, (llm) => llm.object("segment_input", request)));
    expect(result.tier).toBe("standard");
    expect(result.lowConfidence).toBe(true);
    expect(models.calls).toHaveLength(1);
  });

  test("refusals surface as refusal errors and are not retried", async () => {
    const { runExit, models } = setup({
      "std-m": [{ text: "", finishReason: "content-filter" }],
    });
    const exit = await runExit(Effect.flatMap(Llm, (llm) => llm.object("classify_item", request)));
    expect(
      exit._tag === "Failure" && exit.cause._tag === "Fail" && (exit.cause.error as LlmError).kind,
    ).toBe("refusal");
    expect(models.calls).toHaveLength(1);
  });

  test("auth failures map to auth errors and are recorded", async () => {
    const { runExit } = setup({ "std-m": [{ status: 401, body: "invalid x-api-key" }] });
    const exit = await runExit(
      Effect.gen(function* () {
        const llm = yield* Llm;
        return yield* llm
          .object("classify_item", request)
          .pipe(Effect.catchAll((e) => Effect.flatMap(rows, (r) => Effect.fail({ e, r }))));
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      const { e, r } = exit.cause.error as {
        e: LlmError;
        r: { ok: boolean; errorKind: string | null }[];
      };
      expect(e.kind).toBe("auth");
      expect(r[0]).toMatchObject({ ok: false, errorKind: "auth" });
    }
  });

  test("no configured tier is a config error", async () => {
    const { runExit } = setup({}, { fast: null, standard: null, strong: null });
    const exit = await runExit(Effect.flatMap(Llm, (llm) => llm.object("classify_item", request)));
    expect(
      exit._tag === "Failure" && exit.cause._tag === "Fail" && (exit.cause.error as LlmError).kind,
    ).toBe("config");
  });
});

describe("Llm.text and Llm.test", () => {
  test("text routes by task", async () => {
    const { run, models } = setup({ "std-m": [{ text: "Brief." }] });
    const r = await run(Effect.flatMap(Llm, (llm) => llm.text("daily_brief", { prompt: "brief" })));
    expect(r.text).toBe("Brief.");
    expect(models.calls[0]?.model).toBe("std-m");
  });

  test("tier test returns text and records a test_connection row with the tier", async () => {
    const { run } = setup({ "fast-m": [{ text: "ready" }] });
    const { r, calls } = await run(
      Effect.gen(function* () {
        const r = yield* (yield* Llm).test({ tier: "fast" });
        return { r, calls: yield* rows };
      }),
    );
    expect(r.text).toBe("ready");
    expect(calls[0]).toMatchObject({
      task: "test_connection",
      tier: "fast",
      model: "fast-m",
      ok: true,
    });
  });

  test("provider test records a row without a tier", async () => {
    const { run } = setup({ "any-m": [{ text: "ready" }] });
    const calls = await run(
      Effect.gen(function* () {
        yield* (yield* Llm).test({ providerId: "p1", model: "any-m" });
        return yield* rows;
      }),
    );
    expect(calls[0]).toMatchObject({ task: "test_connection", tier: null, providerId: "p1" });
  });
});

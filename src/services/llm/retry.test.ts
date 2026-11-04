import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { z } from "zod";
import { llmCalls } from "@/db/schema";
import { type Db, query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { testProvider } from "@/test/helpers";
import { type AttemptEvent, Llm, type LlmError } from ".";
import { type LlmOptions, makeLlmLayer } from "./live";
import { makeScriptedModels, type Scripted } from "./test";

/** The retries of D68 with short pauses and a short call timeout. */
function setup(scripts: Record<string, Scripted[]>, opts: LlmOptions = {}) {
  const models = makeScriptedModels(scripts);
  const deps = Layer.mergeAll(
    makeSettingsTest({
      ...defaultSettings(),
      providers: [testProvider],
      tiers: {
        fast: { providerId: "p1", model: "fast-m" },
        standard: { providerId: "p1", model: "std-m" },
        strong: null,
      },
    }),
    makeSecretsTest({ [secretNames.providerApiKey("p1")]: "k" }),
    DbTest,
    models.layer,
  );
  const layer = Layer.provideMerge(
    makeLlmLayer({ pausesMs: [20, 40], timeoutMs: 60, ...opts }),
    deps,
  );
  const runExit = <A, E>(program: Effect.Effect<A, E, Llm | Db>, signal?: AbortSignal) =>
    Effect.runPromiseExit(Effect.provide(program, layer), signal ? { signal } : undefined);
  return { models, runExit };
}

const Answer = z.object({ target: z.string() });
const ok: Scripted = { text: '{"target":"ABC-1"}' };
const hang: Scripted = { hang: true };
const rows = query((d) => d.select().from(llmCalls).all());

const call = (attempts: AttemptEvent[], extra: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const llm = yield* Llm;
    const r = yield* Effect.either(
      llm.object("classify_item", {
        schema: Answer,
        prompt: "Pick ABC-1",
        hooks: { onAttempt: (e) => attempts.push(e) },
        ...extra,
      }),
    );
    return { r, calls: yield* rows };
  });

describe("Llm retries (D68)", () => {
  test("two timeouts, then an answer on the third attempt, same tier; every attempt counted", async () => {
    const { runExit, models } = setup({ "std-m": [hang, hang, ok] });
    const attempts: AttemptEvent[] = [];
    const exit = await runExit(call(attempts));
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    const { r, calls } = exit.value;
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") expect(r.right).toMatchObject({ tier: "standard", model: "std-m" });
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "std-m", "std-m"]);
    expect(calls.map((c) => [c.ok, c.errorKind])).toEqual([
      [false, "timeout"],
      [false, "timeout"],
      [true, null],
    ]);
    expect(attempts.map((a) => [a.number, a.failures, a.reason, a.pauseMs, a.of])).toEqual([
      [1, 0, null, 0, 3],
      [2, 1, "timeout", 20, 3],
      [3, 2, "timeout", 40, 3],
    ]);
  });

  test("three timeouts fail the call with a timeout", async () => {
    const { runExit, models } = setup({ "std-m": [hang, hang, hang, ok] });
    const exit = await runExit(call([]));
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    const { r, calls } = exit.value;
    expect(r._tag === "Left" && (r.left as LlmError).kind).toBe("timeout");
    expect(models.calls).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });

  test("a 5xx and a 429 are retried", async () => {
    const { runExit, models } = setup({ "std-m": [{ status: 503 }, { status: 429 }, ok] });
    const attempts: AttemptEvent[] = [];
    const exit = await runExit(call(attempts));
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    expect(exit.value.r._tag).toBe("Right");
    expect(models.calls).toHaveLength(3);
    expect(attempts.map((a) => a.reason)).toEqual([null, "network", "rate_limit"]);
  });

  test("a 401 is not retried", async () => {
    const { runExit, models } = setup({ "std-m": [{ status: 401 }, ok] });
    const exit = await runExit(call([]));
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    expect(exit.value.r._tag === "Left" && (exit.value.r.left as LlmError).kind).toBe("auth");
    expect(models.calls).toHaveLength(1);
  });

  test("a schema failure keeps repair, then fails without a retry", async () => {
    const { runExit, models } = setup({ "std-m": [{ text: "nope" }, { text: "nope" }, ok] });
    const exit = await runExit(call([]));
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    expect(exit.value.r._tag === "Left" && (exit.value.r.left as LlmError).kind).toBe("schema");
    // The first call and its repair; no third call.
    expect(models.calls).toHaveLength(2);
  });

  test("an abort during the pause ends it: no further attempt", async () => {
    const { runExit, models } = setup({ "std-m": [hang, ok] }, { pausesMs: [5_000] });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const exit = await runExit(call([]), controller.signal);
    expect(Exit.isInterrupted(exit)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(models.calls).toHaveLength(1);
  });

  test("the user's 'Use the fast tier' cuts the call short and answers on fast", async () => {
    const { runExit, models } = setup({ "std-m": [hang], "fast-m": [ok] }, { timeoutMs: 5_000 });
    const attempts: AttemptEvent[] = [];
    let asked = false;
    const exit = await runExit(
      call(attempts, {
        hooks: {
          onAttempt: (e: AttemptEvent) => attempts.push(e),
          // Only the first attempt is cut short.
          skip: () =>
            asked
              ? new Promise(() => undefined)
              : new Promise((resolve) => {
                  asked = true;
                  setTimeout(() => resolve({ tier: "fast" }), 30);
                }),
        },
      }),
    );
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    const { r, calls } = exit.value;
    if (r._tag !== "Right") throw new Error("expected an answer");
    expect(r.right).toMatchObject({ tier: "fast", model: "fast-m" });
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "fast-m"]);
    expect(attempts.map((a) => [a.number, a.failures, a.reason])).toEqual([
      [1, 0, null],
      [2, 0, "user"],
    ]);
    expect(calls.map((c) => c.errorKind)).toEqual(["skipped", null]);
  });

  test("the fast tier chosen after a timeout gets its own three attempts", async () => {
    const { runExit, models } = setup({ "std-m": [hang, hang], "fast-m": [hang, hang, ok] });
    const attempts: AttemptEvent[] = [];
    let asked = false;
    const exit = await runExit(
      call(attempts, {
        hooks: {
          onAttempt: (e: AttemptEvent) => attempts.push(e),
          // After the first timeout, the user picks the fast tier.
          skip: () =>
            !asked && attempts.length === 2
              ? new Promise((resolve) => {
                  asked = true;
                  resolve({ tier: "fast" });
                })
              : new Promise(() => undefined),
        },
      }),
    );
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    expect(exit.value.r._tag).toBe("Right");
    // The choice comes in the pause before the second attempt: no second std-m call.
    expect(models.calls.map((c) => c.model)).toEqual(["std-m", "fast-m", "fast-m", "fast-m"]);
    // The fast tier's own count: two timeouts on it, then the answer on its third.
    expect(attempts.map((a) => [a.model, a.failures])).toEqual([
      ["std-m", 0],
      ["std-m", 1],
      ["fast-m", 1],
      ["fast-m", 2],
    ]);
  });

  test("a one-off tier runs that tier instead of the routing", async () => {
    const { runExit, models } = setup({ "fast-m": [ok] });
    const exit = await runExit(call([], { tier: "fast" }));
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    expect(models.calls.map((c) => c.model)).toEqual(["fast-m"]);
  });

  test("text retries too", async () => {
    const { runExit, models } = setup({ "std-m": [{ status: 500 }, { text: "Brief." }] });
    const exit = await runExit(
      Effect.flatMap(Llm, (llm) => llm.text("daily_brief", { prompt: "brief" })),
    );
    if (!Exit.isSuccess(exit)) throw new Error("failed");
    expect(exit.value.text).toBe("Brief.");
    expect(models.calls).toHaveLength(2);
  });
});

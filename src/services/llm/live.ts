import { generateText, NoObjectGeneratedError, Output } from "ai";
import { Duration, Effect, Exit, Layer, Option } from "effect";
import { llmCalls } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redact } from "@/lib/redact";
import { Db, query } from "@/services/db";
import { Fetcher } from "@/services/http";
import { getHeaders, Secrets, secretNames } from "@/services/secrets";
import { type AppSettings, type Provider, Settings } from "@/services/settings";
import {
  type CallInfo,
  Llm,
  LlmError,
  ModelFactory,
  type ObjectRequest,
  type ObjectResult,
  type TestResult,
  toLlmError,
  type Usage,
} from ".";
import { callSettings, makeLanguageModel } from "./providers";
import { escalationTarget, findProvider, type ResolvedTier, resolveTask } from "./routing";
import type { InternalTask, TaskType, Tier } from "./tasks";

const TEST_TIMEOUT_MS = 60_000;
const TEST_PROMPT = "Reply with the single word: ready";

type Target = { tier: Tier | null; providerId: string; model: string };

type Prepared = Target & {
  provider: Provider;
  languageModel: ReturnType<typeof makeLanguageModel>;
};

type Meta = {
  task: TaskType | InternalTask;
  escalated: boolean;
  repair: boolean;
  timeoutMs: number;
};

type Attempt<T> =
  | { status: "ok"; value: T; text: string; usage: Usage }
  | { status: "invalid"; text: string; issues: string[]; usage: Usage };

const usageOf = (u: { inputTokens?: number; outputTokens?: number } | undefined): Usage => ({
  inputTokens: u?.inputTokens,
  outputTokens: u?.outputTokens,
});

const noTier = () =>
  new LlmError({
    kind: "config",
    message: "No model tier is configured. Add a provider and bind a tier in Settings.",
  });

const REPAIR_INSTRUCTION = (issues: readonly string[]) =>
  [
    "Your previous answer failed validation with these errors:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Return a corrected answer that satisfies the schema and fixes every error.",
    "Choose only from the options given in the original request. Do not add commentary.",
  ].join("\n");

export const makeLlm = Effect.gen(function* () {
  const settingsSvc = yield* Settings;
  const secrets = yield* Secrets;
  const factory = yield* ModelFactory;
  const db = yield* Db;

  const record = (
    target: Target,
    meta: Meta,
    row: {
      ok: boolean;
      durationMs: number;
      usage?: Usage;
      validationOk: boolean | null;
      errorKind?: string;
    },
  ) =>
    query((d) =>
      d.insert(llmCalls).values({
        id: newId(),
        task: meta.task,
        tier: target.tier,
        providerId: target.providerId,
        model: target.model,
        escalated: meta.escalated,
        repair: meta.repair,
        validationOk: row.validationOk,
        inputTokens: row.usage?.inputTokens ?? null,
        outputTokens: row.usage?.outputTokens ?? null,
        durationMs: row.durationMs,
        ok: row.ok,
        errorKind: row.errorKind ?? null,
        at: nowIso(),
      }),
    ).pipe(
      Effect.provideService(Db, db),
      // Accounting must never break a call.
      Effect.catchAll((e) => Effect.sync(() => logger.warn("llm_calls insert failed", e.message))),
    );

  const prepare = (settings: AppSettings, target: Target) =>
    Effect.gen(function* () {
      const provider = findProvider(settings.providers, target.providerId);
      if (!provider) {
        return yield* new LlmError({
          kind: "config",
          message: `Provider "${target.providerId}" no longer exists. Rebind the tier in Settings.`,
        });
      }
      const apiKey = yield* secrets.get(secretNames.providerApiKey(provider.id)).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
      );
      const headers = yield* getHeaders(provider.id).pipe(
        Effect.provideService(Secrets, secrets),
        Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
      );
      const languageModel = factory.make({ provider, model: target.model, apiKey, headers });
      return { ...target, provider, languageModel } satisfies Prepared;
    });

  /**
   * Runs one provider call with timeout, cancellation and accounting.
   * `validationOk` derives the recorded validation flag from the result.
   */
  const invoke = <A>(
    p: Prepared,
    meta: Meta,
    run: (signal: AbortSignal) => Promise<A>,
    describe: (a: A) => { usage: Usage; validationOk: boolean | null },
  ) =>
    Effect.gen(function* () {
      const started = Date.now();
      const exit = yield* Effect.tryPromise({ try: run, catch: toLlmError }).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(meta.timeoutMs),
          onTimeout: () =>
            new LlmError({
              kind: "timeout",
              message: `No response within ${meta.timeoutMs / 1000}s`,
            }),
        }),
        Effect.exit,
      );
      const durationMs = Date.now() - started;
      if (Exit.isSuccess(exit)) {
        const d = describe(exit.value);
        yield* record(p, meta, { ok: true, durationMs, ...d });
        return exit.value;
      }
      const failure = Exit.causeOption(exit).pipe(
        Option.flatMap((c) => Option.fromNullable(c._tag === "Fail" ? c.error : undefined)),
      );
      yield* record(p, meta, {
        ok: false,
        durationMs,
        validationOk: null,
        errorKind: Option.match(failure, { onNone: () => "interrupted", onSome: (e) => e.kind }),
      });
      return yield* exit;
    });

  const refusal = () =>
    new LlmError({
      kind: "refusal",
      message: "The model declined to answer this request. Rephrase it or try another tier.",
    });

  const objectAttempt = <T>(
    p: Prepared,
    meta: Meta,
    req: ObjectRequest<T>,
    messages: { previous: string; issues: readonly string[] } | null,
  ) =>
    invoke(
      p,
      meta,
      async (signal): Promise<Attempt<T> | "refused"> => {
        const common = {
          model: p.languageModel,
          system: req.system,
          output: Output.object({ schema: req.schema }),
          maxRetries: 1,
          abortSignal: signal,
          ...callSettings(p.provider),
        };
        try {
          const result = messages
            ? await generateText({
                ...common,
                messages: [
                  { role: "user", content: req.prompt },
                  { role: "assistant", content: messages.previous },
                  { role: "user", content: REPAIR_INSTRUCTION(messages.issues) },
                ],
              })
            : await generateText({ ...common, prompt: req.prompt });
          if (result.finishReason === "content-filter") return "refused";
          const value = result.output as T;
          const issues = [...(req.validate?.(value) ?? [])];
          const usage = usageOf(result.usage);
          return issues.length > 0
            ? { status: "invalid", text: result.text, issues, usage }
            : { status: "ok", value, text: result.text, usage };
        } catch (error) {
          if (NoObjectGeneratedError.isInstance(error)) {
            if (error.finishReason === "content-filter") return "refused";
            const cause = error.cause instanceof Error ? error.cause.message : error.message;
            return {
              status: "invalid",
              text: error.text ?? "",
              issues: [redact(cause).slice(0, 2000)],
              usage: usageOf(error.usage),
            };
          }
          throw error;
        }
      },
      (a) =>
        a === "refused"
          ? { usage: usageOf(undefined), validationOk: null }
          : { usage: a.usage, validationOk: a.status === "ok" },
    ).pipe(Effect.flatMap((a) => (a === "refused" ? Effect.fail(refusal()) : Effect.succeed(a))));

  /** One call plus, when allowed, one repair call on the same model. */
  const attemptWithRepair = <T>(
    p: Prepared,
    task: TaskType,
    timeoutMs: number,
    escalated: boolean,
    allowRepair: boolean,
    req: ObjectRequest<T>,
  ) =>
    Effect.gen(function* () {
      const first = yield* objectAttempt(
        p,
        { task, escalated, repair: false, timeoutMs },
        req,
        null,
      );
      if (first.status === "ok" || !allowRepair) return { attempt: first, repaired: false };
      const repaired = yield* objectAttempt(
        p,
        { task: "repair_output", escalated, repair: true, timeoutMs },
        req,
        { previous: first.text, issues: first.issues },
      );
      return { attempt: repaired, repaired: true };
    });

  const targetOf = (r: ResolvedTier): Target => ({
    tier: r.tier,
    providerId: r.binding.providerId,
    model: r.binding.model,
  });

  const info = (p: Prepared, escalated: boolean, repaired: boolean, usage: Usage): CallInfo => ({
    tier: p.tier as Tier,
    providerId: p.providerId,
    model: p.model,
    escalated,
    repaired,
    usage,
  });

  const object = <T>(task: TaskType, req: ObjectRequest<T>) =>
    Effect.gen(function* () {
      const settings = yield* settingsSvc.get.pipe(
        Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
      );
      const route = resolveTask(settings, task);
      if (!route.resolved) return yield* noTier();
      const lowConfidence = (value: T) =>
        req.confidence !== undefined && req.confidence(value) < route.confidenceThreshold;

      const primary = yield* prepare(settings, targetOf(route.resolved));
      const first = yield* attemptWithRepair(primary, task, route.timeoutMs, false, true, req);
      const firstOk = first.attempt.status === "ok" ? first.attempt : undefined;
      if (firstOk && !lowConfidence(firstOk.value)) {
        return {
          ...info(primary, false, first.repaired, firstOk.usage),
          value: firstOk.value,
          lowConfidence: false,
        } satisfies ObjectResult<T>;
      }

      const next = route.escalate ? escalationTarget(settings.tiers, route.resolved) : undefined;
      if (next) {
        const stronger = yield* prepare(settings, targetOf(next));
        const second = yield* attemptWithRepair(stronger, task, route.timeoutMs, true, false, req);
        if (second.attempt.status === "ok") {
          return {
            ...info(stronger, true, false, second.attempt.usage),
            value: second.attempt.value,
            lowConfidence: lowConfidence(second.attempt.value),
          } satisfies ObjectResult<T>;
        }
      }

      if (firstOk) {
        return {
          ...info(primary, false, first.repaired, firstOk.usage),
          value: firstOk.value,
          lowConfidence: true,
        } satisfies ObjectResult<T>;
      }
      const issues = first.attempt.status === "invalid" ? first.attempt.issues : [];
      return yield* new LlmError({
        kind: "schema",
        message: "The model output failed validation after repair and escalation",
        issues,
      });
    });

  const runText = (p: Prepared, meta: Meta, system: string | undefined, prompt: string) =>
    invoke(
      p,
      meta,
      (signal) =>
        generateText({
          model: p.languageModel,
          system,
          prompt,
          maxRetries: 1,
          abortSignal: signal,
          ...callSettings(p.provider),
        }),
      (r) => ({ usage: usageOf(r.usage), validationOk: null }),
    ).pipe(
      Effect.flatMap((r) =>
        r.finishReason === "content-filter"
          ? Effect.fail(refusal())
          : Effect.succeed({ text: r.text, usage: usageOf(r.usage) }),
      ),
    );

  const text = (task: TaskType, req: { system?: string; prompt: string }) =>
    Effect.gen(function* () {
      const settings = yield* settingsSvc.get.pipe(
        Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
      );
      const route = resolveTask(settings, task);
      if (!route.resolved) return yield* noTier();
      const p = yield* prepare(settings, targetOf(route.resolved));
      const r = yield* runText(
        p,
        { task, escalated: false, repair: false, timeoutMs: route.timeoutMs },
        req.system,
        req.prompt,
      );
      return { ...info(p, false, false, r.usage), text: r.text };
    });

  const test = (target: { tier: Tier } | { providerId: string; model: string }) =>
    Effect.gen(function* () {
      const settings = yield* settingsSvc.get.pipe(
        Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
      );
      let t: Target;
      if ("tier" in target) {
        const binding = settings.tiers[target.tier];
        if (!binding) {
          return yield* new LlmError({
            kind: "config",
            message: `The ${target.tier} tier is not bound to a model.`,
          });
        }
        t = { tier: target.tier, providerId: binding.providerId, model: binding.model };
      } else {
        t = { tier: null, providerId: target.providerId, model: target.model };
      }
      const p = yield* prepare(settings, t);
      const started = Date.now();
      const r = yield* runText(
        p,
        { task: "test_connection", escalated: false, repair: false, timeoutMs: TEST_TIMEOUT_MS },
        undefined,
        TEST_PROMPT,
      );
      return {
        text: r.text,
        model: p.model,
        providerId: p.providerId,
        durationMs: Date.now() - started,
        usage: r.usage,
      } satisfies TestResult;
    });

  const route = (task: TaskType) =>
    settingsSvc.get.pipe(
      Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
      Effect.map((s) => resolveTask(s, task)),
    );

  return Llm.of({ object, text, test, route });
});

export const ModelFactoryLive = Layer.effect(
  ModelFactory,
  Effect.map(Fetcher, ({ fetch }) => ({
    make: (req) => makeLanguageModel({ ...req, fetch }),
  })),
);

export const LlmLive = Layer.effect(Llm, makeLlm);

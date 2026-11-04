import { generateText, NoObjectGeneratedError, Output, stepCountIs, streamText } from "ai";
import { Duration, Effect, Exit, Layer, Option } from "effect";
import { llmCalls } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redact } from "@/lib/redact";
import { bindDb, Db } from "@/services/db";
import { Fetcher } from "@/services/http";
import { getHeaders, Secrets, secretNames } from "@/services/secrets";
import { type AppSettings, type Provider, Settings } from "@/services/settings";
import {
  type AttemptEvent,
  type CallHooks,
  type CallInfo,
  Llm,
  LlmError,
  ModelFactory,
  type ObjectRequest,
  type ObjectResult,
  RETRY_ATTEMPTS,
  RETRY_PAUSES_MS,
  RETRYABLE_KINDS,
  type SkipRequest,
  type StreamRequest,
  type TestResult,
  type TestTarget,
  type TextRequest,
  toLlmError,
  type Usage,
} from ".";
import { portableOutputSchema } from "./portable";
import { callSettings, makeLanguageModel } from "./providers";
import {
  escalationTarget,
  findProvider,
  type ResolvedTier,
  resolveTask,
  resolveTier,
} from "./routing";
import type { InternalTask, TaskType, Tier } from "./tasks";

/** Options of the live Llm; tests shorten the pauses and the call timeout. */
export type LlmOptions = {
  /** Pauses before the second and third attempts (D68: 2 s, then 5 s). */
  pausesMs?: readonly number[];
  /** A call timeout for every task instead of the task's own. */
  timeoutMs?: number;
};

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

/** What one call runs with (D68). */
type CallRun = {
  hooks?: CallHooks;
  /** The target for a tier the user switched to during the call. */
  retarget?: (tier: Tier) => Effect.Effect<Prepared, LlmError>;
  /** Attempts in all; `RETRY_ATTEMPTS` unless given. */
  attempts?: number;
};

const makeLlm = (opts: LlmOptions = {}) =>
  Effect.gen(function* () {
    const pauses = opts.pausesMs ?? RETRY_PAUSES_MS;
    const routeOf = (settings: AppSettings, task: TaskType) => {
      const route = resolveTask(settings, task);
      return opts.timeoutMs ? { ...route, timeoutMs: opts.timeoutMs } : route;
    };
    const settingsSvc = yield* Settings;
    const secrets = yield* Secrets;
    const factory = yield* ModelFactory;
    const { q } = bindDb(yield* Db);

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
      q((d) =>
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
        // Accounting must never break a call.
        Effect.catchAll((e) =>
          Effect.sync(() => logger.warn("llm_calls insert failed", e.message)),
        ),
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

    /** Resolves when the user asks to stop waiting (D68); never without the hook. */
    const skipped = (hooks: CallHooks | undefined) => {
      const skip = hooks?.skip;
      return skip
        ? Effect.promise((signal) => skip(signal))
        : (Effect.never as Effect.Effect<SkipRequest>);
    };

    /**
     * Runs one provider call with timeout, cancellation, retries and accounting.
     * A timeout, 5xx, 429 or network failure is tried again on the same target, up
     * to `RETRY_ATTEMPTS` in all, after the pauses (D68); the user may cut an
     * attempt or a pause short, on another tier for the rest of this call. Every
     * attempt is recorded. `validationOk` derives the recorded validation flag
     * from the result. Returns the value and the target that gave it.
     */
    const invoke = <A>(
      first: Prepared,
      meta: Meta,
      run: (p: Prepared, signal: AbortSignal) => Promise<A>,
      describe: (a: A) => { usage: Usage; validationOk: boolean | null },
      call: CallRun = {},
    ) =>
      Effect.gen(function* () {
        let p = first;
        let number = 0;
        let failures = 0;
        let reason: AttemptEvent["reason"] = null;
        let pauseMs = 0;
        // Another tier is another provider call: it gets its own three attempts.
        const switchTo = (s: SkipRequest) => {
          if (!s.tier || !call.retarget) return Effect.succeed(p);
          failures = 0;
          return call.retarget(s.tier);
        };
        for (;;) {
          number++;
          call.hooks?.onAttempt?.({
            task: meta.task,
            number,
            failures,
            of: RETRY_ATTEMPTS,
            reason,
            pauseMs,
            tier: p.tier,
            providerId: p.providerId,
            model: p.model,
            repair: meta.repair,
            escalated: meta.escalated,
            at: Date.now(),
          });
          if (pauseMs > 0) {
            // The pause ends early when the user asks; the abort of the run ends it too.
            const cut = yield* Effect.raceFirst(
              Effect.as(Effect.sleep(Duration.millis(pauseMs)), null),
              skipped(call.hooks),
            );
            if (cut) p = yield* switchTo(cut);
          }
          const started = Date.now();
          const exit = yield* Effect.raceFirst(
            Effect.tryPromise({ try: (signal) => run(p, signal), catch: toLlmError }).pipe(
              Effect.timeoutFail({
                duration: Duration.millis(meta.timeoutMs),
                onTimeout: () =>
                  new LlmError({
                    kind: "timeout",
                    message: `No response within ${meta.timeoutMs / 1000}s`,
                  }),
              }),
              Effect.map((value) => ({ done: true as const, value })),
            ),
            Effect.map(skipped(call.hooks), (s) => ({ done: false as const, skip: s })),
          ).pipe(Effect.exit);
          const durationMs = Date.now() - started;
          if (Exit.isSuccess(exit)) {
            const r = exit.value;
            if (r.done) {
              yield* record(p, meta, { ok: true, durationMs, ...describe(r.value) });
              return { value: r.value, p };
            }
            // The user cut this attempt short: the next one starts now and is not a failure.
            yield* record(p, meta, {
              ok: false,
              durationMs,
              validationOk: null,
              errorKind: "skipped",
            });
            p = yield* switchTo(r.skip);
            reason = "user";
            pauseMs = 0;
            continue;
          }
          const failure = Exit.causeOption(exit).pipe(
            Option.flatMap((c) => Option.fromNullable(c._tag === "Fail" ? c.error : undefined)),
          );
          yield* record(p, meta, {
            ok: false,
            durationMs,
            validationOk: null,
            errorKind: Option.match(failure, {
              onNone: () => "interrupted",
              onSome: (e) => e.kind,
            }),
          });
          const kind = Option.getOrUndefined(failure)?.kind;
          if (
            kind &&
            RETRYABLE_KINDS.includes(kind) &&
            failures + 1 < (call.attempts ?? RETRY_ATTEMPTS)
          ) {
            failures++;
            reason = kind;
            pauseMs = pauses[failures - 1] ?? pauses.at(-1) ?? 0;
            continue;
          }
          return yield* Effect.failCause(exit.cause);
        }
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
      call: CallRun,
    ) =>
      invoke(
        p,
        meta,
        async (p, signal): Promise<Attempt<T> | "refused"> => {
          const common = {
            model: p.languageModel,
            system: req.system,
            output: Output.object({ schema: portableOutputSchema(req.schema) }),
            // The call runner retries (D68); the SDK's own retry would double it.
            maxRetries: 0,
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
        call,
      ).pipe(
        Effect.flatMap((r) =>
          r.value === "refused"
            ? Effect.fail(refusal())
            : Effect.succeed({ attempt: r.value, p: r.p }),
        ),
      );

    /**
     * One call plus, when allowed, one repair call on the same model (the one
     * that answered, when the user switched tiers during the call).
     */
    const attemptWithRepair = <T>(
      p: Prepared,
      task: TaskType,
      timeoutMs: number,
      escalated: boolean,
      allowRepair: boolean,
      req: ObjectRequest<T>,
      call: CallRun,
    ) =>
      Effect.gen(function* () {
        const first = yield* objectAttempt(
          p,
          { task, escalated, repair: false, timeoutMs },
          req,
          null,
          call,
        );
        if (first.attempt.status === "ok" || !allowRepair)
          return { attempt: first.attempt, repaired: false, p: first.p };
        const repaired = yield* objectAttempt(
          first.p,
          { task: "repair_output", escalated, repair: true, timeoutMs },
          req,
          { previous: first.attempt.text, issues: first.attempt.issues },
          call,
        );
        return { attempt: repaired.attempt, repaired: true, p: repaired.p };
      });

    /** Settings read failures are configuration errors for the caller to fix. */
    const loadSettings = settingsSvc.get.pipe(
      Effect.mapError((e) => new LlmError({ kind: "config", message: e.message })),
    );

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

    /** The target for an explicit tier or provider/model. */
    const explicit = (settings: AppSettings, target: TestTarget) =>
      Effect.gen(function* () {
        if (!("tier" in target)) return { tier: null, ...target } satisfies Target;
        const binding = settings.tiers[target.tier];
        if (!binding)
          return yield* new LlmError({
            kind: "config",
            message: `The ${target.tier} tier is not bound to a model.`,
          });
        return targetOf({ tier: target.tier, binding });
      });

    /** What one call runs with: the user's hooks and a way to switch tiers mid-call (D68). */
    const callOf = (settings: AppSettings, hooks: CallHooks | undefined): CallRun => ({
      hooks,
      retarget: (tier) =>
        Effect.flatMap(explicit(settings, { tier }), (target) => prepare(settings, target)),
    });

    const object = <T>(task: TaskType, req: ObjectRequest<T>) =>
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        const route = routeOf(settings, task);
        const call = callOf(settings, req.hooks);
        if (req.target) {
          const p = yield* prepare(settings, yield* explicit(settings, req.target));
          const r = yield* attemptWithRepair(p, task, route.timeoutMs, false, true, req, call);
          if (r.attempt.status === "ok")
            return {
              ...info(r.p, false, r.repaired, r.attempt.usage),
              value: r.attempt.value,
              lowConfidence: false,
            } satisfies ObjectResult<T>;
          return yield* new LlmError({
            kind: "schema",
            message: "The model output failed validation after repair",
            issues: r.attempt.issues,
          });
        }
        // The one-off tier of the fast-tier buttons (D68); routing otherwise.
        const resolved = req.tier ? resolveTier(settings.tiers, req.tier) : route.resolved;
        if (!resolved) return yield* noTier();
        const lowConfidence = (value: T) =>
          req.confidence !== undefined && req.confidence(value) < route.confidenceThreshold;

        const primary = yield* prepare(settings, targetOf(resolved));
        const first = yield* attemptWithRepair(
          primary,
          task,
          route.timeoutMs,
          false,
          true,
          req,
          call,
        );
        const firstOk = first.attempt.status === "ok" ? first.attempt : undefined;
        if (firstOk && !lowConfidence(firstOk.value)) {
          return {
            ...info(first.p, false, first.repaired, firstOk.usage),
            value: firstOk.value,
            lowConfidence: false,
          } satisfies ObjectResult<T>;
        }

        const next = route.escalate ? escalationTarget(settings.tiers, resolved) : undefined;
        if (next) {
          const stronger = yield* prepare(settings, targetOf(next));
          const second = yield* attemptWithRepair(
            stronger,
            task,
            route.timeoutMs,
            true,
            false,
            req,
            call,
          );
          if (second.attempt.status === "ok") {
            return {
              ...info(second.p, true, false, second.attempt.usage),
              value: second.attempt.value,
              lowConfidence: lowConfidence(second.attempt.value),
            } satisfies ObjectResult<T>;
          }
        }

        if (firstOk) {
          return {
            ...info(first.p, false, first.repaired, firstOk.usage),
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

    const runText = (
      p: Prepared,
      meta: Meta,
      system: string | undefined,
      prompt: string,
      call: CallRun,
    ) =>
      invoke(
        p,
        meta,
        (p, signal) =>
          generateText({
            model: p.languageModel,
            system,
            prompt,
            // The call runner retries (D68).
            maxRetries: 0,
            abortSignal: signal,
            ...callSettings(p.provider),
          }),
        (r) => ({ usage: usageOf(r.usage), validationOk: null }),
        call,
      ).pipe(
        Effect.flatMap(({ value: r, p }) =>
          r.finishReason === "content-filter"
            ? Effect.fail(refusal())
            : Effect.succeed({ text: r.text, usage: usageOf(r.usage), p }),
        ),
      );

    const text = (task: TaskType, req: TextRequest) =>
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        const route = routeOf(settings, task);
        const resolved = req.tier ? resolveTier(settings.tiers, req.tier) : route.resolved;
        if (!resolved) return yield* noTier();
        const p = yield* prepare(settings, targetOf(resolved));
        const r = yield* runText(
          p,
          { task, escalated: false, repair: false, timeoutMs: route.timeoutMs },
          req.system,
          req.prompt,
          callOf(settings, req.hooks),
        );
        return { ...info(r.p, false, false, r.usage), text: r.text };
      });

    const test = (target: TestTarget) =>
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        const p = yield* prepare(settings, yield* explicit(settings, target));
        const started = Date.now();
        // A connection test answers at once: no retries.
        const r = yield* runText(
          p,
          { task: "test_connection", escalated: false, repair: false, timeoutMs: TEST_TIMEOUT_MS },
          undefined,
          TEST_PROMPT,
          { attempts: 1 },
        );
        return {
          text: r.text,
          model: p.model,
          providerId: p.providerId,
          durationMs: Date.now() - started,
          usage: r.usage,
        } satisfies TestResult;
      });

    const stream = (task: TaskType, req: StreamRequest) =>
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        const routed = routeOf(settings, task);
        let target: Target;
        if (req.tier) target = yield* explicit(settings, { tier: req.tier });
        else if (routed.resolved) target = targetOf(routed.resolved);
        else return yield* noTier();
        const p = yield* prepare(settings, target);
        const meta: Meta = { task, escalated: false, repair: false, timeoutMs: routed.timeoutMs };
        const started = Date.now();
        const done = (row: { ok: boolean; usage?: Usage; errorKind?: string }) =>
          void Effect.runPromise(
            record(p, meta, { ...row, durationMs: Date.now() - started, validationOk: null }),
          );
        const result = streamText({
          model: p.languageModel,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          stopWhen: stepCountIs(req.maxSteps),
          prepareStep: req.prepareStep,
          maxRetries: 1,
          abortSignal: req.abortSignal,
          ...callSettings(p.provider),
          onFinish: (e) =>
            done({ ok: true, usage: usageOf((e as { totalUsage?: Usage }).totalUsage) }),
          onError: ({ error }) => done({ ok: false, errorKind: toLlmError(error).kind }),
        });
        return result.toUIMessageStream({
          // The chat shows the reason instead of a generic failure; keys are redacted.
          onError: (error) => redact(toLlmError(error).message),
        });
      });

    const route = (task: TaskType) => Effect.map(loadSettings, (s) => resolveTask(s, task));

    return Llm.of({ object, text, stream, test, route });
  });

export const ModelFactoryLive = Layer.effect(
  ModelFactory,
  Effect.map(Fetcher, ({ fetch }) => ({
    make: (req) => makeLanguageModel({ ...req, fetch }),
  })),
);

/** The Llm with other retry pauses or a shorter call timeout; tests use it. */
export const makeLlmLayer = (opts: LlmOptions) => Layer.effect(Llm, makeLlm(opts));

export const LlmLive = Layer.effect(Llm, makeLlm());

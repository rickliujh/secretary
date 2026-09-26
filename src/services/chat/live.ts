import { convertToModelMessages, type ModelMessage } from "ai";
import { Effect, Layer } from "effect";
import { redact } from "@/lib/redact";
import { buildChatSystem, CHAT_MAX_STEPS } from "@/prompts/chat";
import { localDate } from "@/services/intake";
import { Llm, LlmError } from "@/services/llm";
import { Settings, settingsOrDefault } from "@/services/settings";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { Chat, type ChatRequest } from ".";
import { imagesMessage } from "./images";
import { chatTools, type ToolDeps } from "./tools";

const make = Effect.gen(function* () {
  const llm = yield* Llm;
  const deps = yield* Effect.context<ToolDeps>();
  // Tools run in the app's services; a failing tool tells the model why instead of
  // ending the turn.
  const exec = <A, E>(effect: Effect.Effect<A, E, ToolDeps>) =>
    Effect.runPromise(
      Effect.provide(effect, deps).pipe(
        Effect.catchAll((e) =>
          Effect.succeed({
            error: redact((e as { message?: string }).message ?? String(e)),
          }),
        ),
      ),
    );

  const stream = (req: ChatRequest) =>
    Effect.gen(function* () {
      // Images a tool fetched in this turn, handed to every later step as user
      // messages; tool results cannot carry them to OpenAI-compatible models (D33).
      const images = new Map<string, ModelMessage>();
      const tools = chatTools(exec, (callId, key, shown) =>
        images.set(callId, imagesMessage(key, shown)),
      );
      const settings = yield* Effect.provide(Effect.flatMap(Settings, settingsOrDefault), deps);
      const me = yield* Effect.provide(getState(SYNC_KEYS.username), deps).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const messages = yield* Effect.tryPromise({
        try: () => convertToModelMessages(req.messages, { tools, ignoreIncompleteToolCalls: true }),
        catch: (e) =>
          new LlmError({
            kind: "provider",
            message: `Could not read the conversation: ${String(e)}`,
          }),
      });
      return yield* llm.stream("chat", {
        system: buildChatSystem({
          today: localDate(),
          me: me ?? null,
          language: settings.general.outputLanguage,
        }),
        messages,
        tools,
        maxSteps: CHAT_MAX_STEPS,
        tier: req.tier,
        abortSignal: req.abortSignal,
        prepareStep: ({ messages: current }) =>
          images.size ? { messages: [...current, ...images.values()] } : {},
      });
    });

  return Chat.of({ stream });
});

export const ChatLive = Layer.effect(Chat, make);

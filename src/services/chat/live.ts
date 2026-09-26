import { convertToModelMessages } from "ai";
import { Effect, Layer } from "effect";
import { redact } from "@/lib/redact";
import { buildChatSystem, CHAT_MAX_STEPS } from "@/prompts/chat";
import { localDate } from "@/services/intake";
import { Llm, LlmError } from "@/services/llm";
import { Settings } from "@/services/settings";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { Chat, type ChatRequest } from ".";
import { chatTools, type ToolDeps } from "./tools";

const make = Effect.gen(function* () {
  const llm = yield* Llm;
  const deps = yield* Effect.context<ToolDeps>();
  // Tools run in the app's services; a failing tool tells the model why instead of
  // ending the turn.
  const tools = chatTools((effect) =>
    Effect.runPromise(
      Effect.provide(effect, deps).pipe(
        Effect.catchAll((e) =>
          Effect.succeed({
            error: redact((e as { message?: string }).message ?? String(e)),
          }),
        ),
      ),
    ),
  );

  const stream = (req: ChatRequest) =>
    Effect.gen(function* () {
      const settings = yield* Effect.provide(
        Effect.flatMap(Settings, (x) => x.get),
        deps,
      ).pipe(Effect.orElseSucceed(() => undefined));
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
          language: settings?.general.outputLanguage ?? "English",
        }),
        messages,
        tools,
        maxSteps: CHAT_MAX_STEPS,
        tier: req.tier,
        abortSignal: req.abortSignal,
      });
    });

  return Chat.of({ stream });
});

export const ChatLive = Layer.effect(Chat, make);

import type { UIMessage, UIMessageChunk } from "ai";
import { Context, type Effect } from "effect";
import type { LlmError, Tier } from "@/services/llm";

export type ChatRequest = {
  messages: UIMessage[];
  /** Overrides the chat task's routing (the tier picker). */
  tier?: Tier;
  abortSignal?: AbortSignal;
};

export interface ChatShape {
  /** One assistant turn: a tool loop over local data, streamed to the UI (D25). */
  readonly stream: (req: ChatRequest) => Effect.Effect<ReadableStream<UIMessageChunk>, LlmError>;
}

export class Chat extends Context.Tag("Chat")<Chat, ChatShape>() {}

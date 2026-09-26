import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { Effect } from "effect";
import { run } from "@/app/runtime";
import { Chat } from "@/services/chat";
import type { Tier } from "@/services/llm";

/**
 * `useChat` transport that runs the Chat service in the webview (design.md D25):
 * no HTTP server, the same services and keychain as the rest of the app.
 */
export class SecretaryTransport implements ChatTransport<UIMessage> {
  constructor(private readonly tier: () => Tier | undefined) {}

  sendMessages({
    messages,
    abortSignal,
  }: {
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    return run(
      Effect.flatMap(Chat, (c) => c.stream({ messages, tier: this.tier(), abortSignal })),
      abortSignal,
    );
  }

  /** Conversations live in the page session, so there is nothing to resume. */
  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}

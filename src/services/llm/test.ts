/** Test helpers: scripted mock models behind the real Llm implementation. */
import { APICallError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Layer } from "effect";
import type { Provider } from "@/services/settings/schema";
import { ModelFactory } from ".";

export type Scripted =
  | { text: string; finishReason?: "stop" | "content-filter" }
  | { status: number; body?: string }
  /** Streaming only: the model calls a tool (the chat's tool loop). */
  | { toolCall: { name: string; input: unknown } };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export type ModelCall = {
  providerId: string;
  model: string;
  apiKey: string | undefined;
  prompt: unknown;
};

/**
 * Each model id gets a queue of scripted responses, consumed in order.
 * `calls` records every request so tests can assert routing.
 */
export function makeScriptedModels(scripts: Record<string, Scripted[]>) {
  const queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  const calls: ModelCall[] = [];
  const make = ({
    provider,
    model,
    apiKey,
  }: {
    provider: Provider;
    model: string;
    apiKey: string | undefined;
    headers: Record<string, string>;
  }) =>
    new MockLanguageModelV4({
      modelId: model,
      doGenerate: async (options) => {
        calls.push({ providerId: provider.id, model, apiKey, prompt: options.prompt });
        const next = queues.get(model)?.shift();
        if (!next) throw new Error(`No scripted response left for ${model}`);
        if ("status" in next) {
          throw new APICallError({
            message: `HTTP ${next.status}`,
            url: "https://llm.test",
            requestBodyValues: {},
            statusCode: next.status,
            responseBody: next.body ?? "",
            isRetryable: false,
          });
        }
        if ("toolCall" in next) throw new Error("Scripted tool calls need a streaming call");
        return {
          content: [{ type: "text", text: next.text }],
          finishReason: { unified: next.finishReason ?? "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
      doStream: async (options) => {
        calls.push({ providerId: provider.id, model, apiKey, prompt: options.prompt });
        const next = queues.get(model)?.shift();
        if (!next) throw new Error(`No scripted response left for ${model}`);
        if ("status" in next)
          throw new APICallError({
            message: `HTTP ${next.status}`,
            url: "https://llm.test",
            requestBodyValues: {},
            statusCode: next.status,
            responseBody: next.body ?? "",
            isRetryable: false,
          });
        const body =
          "toolCall" in next
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: `call-${calls.length}`,
                  toolName: next.toolCall.name,
                  input: JSON.stringify(next.toolCall.input),
                },
              ]
            : [
                { type: "text-start" as const, id: "t" },
                { type: "text-delta" as const, id: "t", delta: next.text },
                { type: "text-end" as const, id: "t" },
              ];
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              ...body,
              {
                type: "finish" as const,
                usage,
                finishReason: {
                  unified: "toolCall" in next ? ("tool-calls" as const) : ("stop" as const),
                  raw: undefined,
                },
              },
            ],
          }),
        };
      },
    });
  return { layer: Layer.succeed(ModelFactory, { make }), calls, remaining: () => queues };
}

/**
 * Builds AI SDK language models from provider settings (design.md section 7.1).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { FetchFn } from "@/services/http";
import type { Provider } from "@/services/settings/schema";

export type ModelRequest = {
  provider: Provider;
  model: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  fetch: FetchFn;
};

export function makeLanguageModel({
  provider,
  model,
  apiKey,
  headers,
  fetch,
}: ModelRequest): LanguageModel {
  if (provider.kind === "anthropic") {
    const anthropic = createAnthropic({
      baseURL: provider.baseUrl,
      ...(provider.authStyle === "bearer" ? { authToken: apiKey ?? "" } : { apiKey: apiKey ?? "" }),
      headers,
      fetch: fetch as typeof globalThis.fetch,
    });
    return anthropic(model);
  }
  const compatible = createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    apiKey,
    headers,
    fetch: fetch as typeof globalThis.fetch,
    includeUsage: true,
    supportsStructuredOutputs: provider.jsonSchemaOutputs,
  });
  return compatible.chatModel(model);
}

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type CallSettings = {
  temperature?: number;
  seed?: number;
  providerOptions?: Record<string, JsonObject>;
};

/**
 * Sampling and provider options. Anthropic models reject temperature, so
 * consistency there comes from schemas and candidates, not sampling
 * (design.md 7.0 rule 6).
 */
export function callSettings(provider: Provider): CallSettings {
  if (provider.kind === "anthropic") {
    const anthropic: JsonObject = { structuredOutputMode: provider.structuredOutputMode };
    if (provider.thinking !== "default") anthropic.thinking = { type: provider.thinking };
    if (provider.effort !== "default") anthropic.effort = provider.effort;
    return { providerOptions: { anthropic } };
  }
  return {
    ...(provider.sendTemperature ? { temperature: 0 } : {}),
    ...(provider.seed !== undefined ? { seed: provider.seed } : {}),
  };
}

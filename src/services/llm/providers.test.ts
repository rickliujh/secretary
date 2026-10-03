import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { ProviderSchema } from "@/services/settings/schema";
import { callSettings, makeLanguageModel, reasoningEffort } from "./providers";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function stubFetch(responseBody: unknown) {
  const captured: Captured[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, captured };
}

const anthropicReply = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "ready" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
};

const openaiReply = {
  id: "c1",
  object: "chat.completion",
  created: 0,
  model: "local",
  choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

describe("provider construction", () => {
  test("anthropic sends x-api-key, extra headers, and opt-in effort without temperature", async () => {
    const provider = ProviderSchema.parse({
      id: "a",
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      effort: "low",
    });
    const { fetch, captured } = stubFetch(anthropicReply);
    const model = makeLanguageModel({
      provider,
      model: "claude-sonnet-5",
      apiKey: "sk-test",
      headers: { "X-Proxy": "p" },
      fetch,
    });
    const r = await generateText({ model, prompt: "hi", ...callSettings(provider) });
    expect(r.text).toBe("ready");
    expect(captured[0]?.url).toBe("https://api.anthropic.test/v1/messages");
    expect(captured[0]?.headers["x-api-key"]).toBe("sk-test");
    expect(captured[0]?.headers["x-proxy"]).toBe("p");
    expect(captured[0]?.body.temperature).toBeUndefined();
    expect(JSON.stringify(captured[0]?.body)).toContain('"effort":"low"');
  });

  test("anthropic bearer auth style uses Authorization", async () => {
    const provider = ProviderSchema.parse({
      id: "a",
      name: "Proxy",
      kind: "anthropic",
      baseUrl: "https://proxy.test/v1",
      authStyle: "bearer",
    });
    const { fetch, captured } = stubFetch(anthropicReply);
    const model = makeLanguageModel({
      provider,
      model: "m",
      apiKey: "tok-123",
      headers: {},
      fetch,
    });
    await generateText({ model, prompt: "hi", ...callSettings(provider) });
    expect(captured[0]?.headers.authorization).toBe("Bearer tok-123");
    expect(captured[0]?.headers["x-api-key"]).toBeUndefined();
  });

  test("openai-compatible sends bearer key, temperature 0 and seed", async () => {
    const provider = ProviderSchema.parse({
      id: "o",
      name: "Local",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      seed: 7,
    });
    const { fetch, captured } = stubFetch(openaiReply);
    const model = makeLanguageModel({
      provider,
      model: "local",
      apiKey: "k-1",
      headers: {},
      fetch,
    });
    const r = await generateText({ model, prompt: "hi", ...callSettings(provider) });
    expect(r.text).toBe("ready");
    expect(captured[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(captured[0]?.headers.authorization).toBe("Bearer k-1");
    expect(captured[0]?.body.temperature).toBe(0);
    expect(captured[0]?.body.seed).toBe(7);
    // Provider default sends no reasoning field: compatible servers may reject it.
    expect("reasoning_effort" in (captured[0]?.body ?? {})).toBe(false);
  });

  test("openai-compatible sends a chosen effort as reasoning_effort", async () => {
    const provider = ProviderSchema.parse({
      id: "o",
      name: "Router",
      kind: "openai-compatible",
      baseUrl: "https://router.test/v1",
      effort: "low",
    });
    const { fetch, captured } = stubFetch(openaiReply);
    const model = makeLanguageModel({ provider, model: "m", apiKey: "k", headers: {}, fetch });
    await generateText({ model, prompt: "hi", ...callSettings(provider) });
    expect(captured[0]?.body.reasoning_effort).toBe("low");
    expect(captured[0]?.body.temperature).toBe(0);
  });
});

describe("reasoning effort for OpenAI-compatible providers (D52)", () => {
  test("maps every setting value", () => {
    expect(reasoningEffort("default")).toBeUndefined();
    expect(reasoningEffort("low")).toBe("low");
    expect(reasoningEffort("medium")).toBe("medium");
    expect(reasoningEffort("high")).toBe("high");
    expect(reasoningEffort("xhigh")).toBe("xhigh");
    // The field has nothing above xhigh.
    expect(reasoningEffort("max")).toBe("xhigh");
  });

  test("anthropic providers keep their own effort option", () => {
    const provider = ProviderSchema.parse({
      id: "a",
      name: "A",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      effort: "max",
    });
    expect(callSettings(provider).providerOptions).toEqual({
      anthropic: { structuredOutputMode: "auto", effort: "max" },
    });
  });
});

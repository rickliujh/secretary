/**
 * Live smoke test of `read_image` (Phase 35, D71) against a real model: the
 * PNG fixture of a short chat message (made with ImageMagick, see
 * `src/test/fixtures/images/chat-request.png`) is transcribed through the
 * real Llm, and the transcript must hold the sender's name and the request.
 * Skipped unless configured, with the same variables as the other evals; the
 * task is standard tier:
 *
 *   SECRETARY_EVAL_KIND=anthropic
 *   SECRETARY_EVAL_BASE_URL=https://api.anthropic.com/v1
 *   SECRETARY_EVAL_API_KEY=...
 *   SECRETARY_EVAL_STANDARD_MODEL=claude-haiku-5-5
 *   bun test src/test/eval/image-read
 *
 * Nothing touches Jira or the note.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  buildImageReadPrompt,
  type ImageReadOutput,
  ImageReadSchema,
  validateImageRead,
} from "@/prompts/read-image";
import { DbTest } from "@/services/db/test";
import { makeFetcherTest } from "@/services/http";
import { Llm } from "@/services/llm";
import { LlmLive, ModelFactoryLive } from "@/services/llm/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings, ProviderSchema } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";

const env = process.env;
const configured = !!(
  env.SECRETARY_EVAL_API_KEY &&
  env.SECRETARY_EVAL_BASE_URL &&
  env.SECRETARY_EVAL_STANDARD_MODEL
);
const FIXTURE = join(import.meta.dir, "../fixtures/images/chat-request.png");

function layer() {
  const provider = ProviderSchema.parse({
    id: "eval",
    name: "Eval",
    kind: env.SECRETARY_EVAL_KIND === "openai-compatible" ? "openai-compatible" : "anthropic",
    baseUrl: env.SECRETARY_EVAL_BASE_URL,
  });
  const bind = { providerId: "eval", model: env.SECRETARY_EVAL_STANDARD_MODEL ?? "" };
  const base = Layer.mergeAll(
    makeSettingsTest({
      ...defaultSettings(),
      providers: [provider],
      tiers: { fast: null, standard: bind, strong: null },
    }),
    makeSecretsTest({ [secretNames.providerApiKey("eval")]: env.SECRETARY_EVAL_API_KEY ?? "" }),
    makeFetcherTest((input, init) => fetch(input, init)),
    DbTest,
  );
  return Layer.provideMerge(LlmLive, Layer.provideMerge(ModelFactoryLive, base));
}

describe.skipIf(!configured)("read_image (live)", () => {
  test(
    "a screenshot of a chat message is transcribed with its sender and request",
    async () => {
      const data = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
      const r = await Effect.runPromise(
        Effect.flatMap(Llm, (llm) =>
          llm.object<ImageReadOutput>("read_image", {
            schema: ImageReadSchema,
            ...buildImageReadPrompt({ name: "Pasted image 20261105101500.png" }),
            images: [{ mediaType: "image/png", data }],
            validate: validateImageRead,
          }),
        ).pipe(Effect.provide(layer())),
      );
      console.log(
        `read_image on ${r.model}: kind ${r.value.kind}, repaired ${r.repaired}\n  description: ${r.value.description}\n  text: ${r.value.text}`,
      );
      expect(r.value.kind).toBe("chat");
      expect(r.value.text).toContain("Priya Raman");
      expect(r.value.text.toLowerCase()).toContain("rate limit");
      expect(r.value.text).toContain("500");
      expect(r.value.text.toLowerCase()).toContain("billing api");
    },
    2 * 60 * 1000,
  );
});

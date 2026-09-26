import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { Secrets, secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings, Settings } from ".";
import { deleteProvider, parseHeaderLines, saveProvider } from "./providers";
import { makeSettingsTest } from "./test";

const layer = () => Layer.mergeAll(makeSettingsTest(defaultSettings()), makeSecretsTest());

const base = {
  name: "Proxy",
  kind: "anthropic" as const,
  baseUrl: "https://proxy.test/v1",
  authStyle: "x-api-key" as const,
  thinking: "default" as const,
  effort: "default" as const,
  structuredOutputMode: "auto" as const,
  jsonSchemaOutputs: true,
  sendTemperature: true,
};

describe("parseHeaderLines", () => {
  test("parses name/value lines and reports bad ones", () => {
    const r = parseHeaderLines("X-Proxy-Auth: abc\n\nbad line\nX-Team:  core ");
    expect(r.headers).toEqual({ "X-Proxy-Auth": "abc", "X-Team": "core" });
    expect(r.errors).toEqual(['Line 3: expected "Name: value"']);
  });
});

describe("saveProvider / deleteProvider", () => {
  test("secrets go to the keychain and never into settings", async () => {
    const program = Effect.gen(function* () {
      const p = yield* saveProvider({
        ...base,
        apiKey: "sk-provider-secret",
        addHeaders: { "X-Proxy-Auth": "hdr-secret-value" },
      });
      const settings = yield* (yield* Settings).get;
      const secrets = yield* Secrets;
      const key = yield* secrets.get(secretNames.providerApiKey(p.id));
      const headers = yield* secrets.get(secretNames.providerHeaders(p.id));
      return { p, settings, key, headers };
    });
    const r = await Effect.runPromise(Effect.provide(program, layer()));
    const serialized = JSON.stringify(r.settings);
    expect(serialized).not.toContain("sk-provider-secret");
    expect(serialized).not.toContain("hdr-secret-value");
    expect(r.settings.providers[0]?.headerNames).toEqual(["X-Proxy-Auth"]);
    expect(Option.getOrNull(r.key)).toBe("sk-provider-secret");
    expect(JSON.parse(Option.getOrThrow(r.headers))).toEqual({
      "X-Proxy-Auth": "hdr-secret-value",
    });
  });

  test("editing keeps the stored key when blank and applies header removals", async () => {
    const program = Effect.gen(function* () {
      const p = yield* saveProvider({
        ...base,
        apiKey: "sk-first-000000",
        addHeaders: { A: "1", B: "2" },
      });
      yield* saveProvider({ ...base, id: p.id, name: "Renamed", apiKey: "", removeHeaders: ["A"] });
      const settings = yield* (yield* Settings).get;
      const key = yield* (yield* Secrets).get(secretNames.providerApiKey(p.id));
      return { settings, key };
    });
    const r = await Effect.runPromise(Effect.provide(program, layer()));
    expect(r.settings.providers).toHaveLength(1);
    expect(r.settings.providers[0]?.name).toBe("Renamed");
    expect(r.settings.providers[0]?.headerNames).toEqual(["B"]);
    expect(Option.getOrNull(r.key)).toBe("sk-first-000000");
  });

  test("deleting unbinds tiers and removes keychain entries", async () => {
    const program = Effect.gen(function* () {
      const p = yield* saveProvider({ ...base, apiKey: "sk-delete-me-000" });
      const settings = yield* Settings;
      yield* settings.update((s) => ({
        ...s,
        tiers: { ...s.tiers, standard: { providerId: p.id, model: "m" } },
      }));
      yield* deleteProvider(p.id);
      return {
        s: yield* settings.get,
        key: yield* (yield* Secrets).get(secretNames.providerApiKey(p.id)),
      };
    });
    const r = await Effect.runPromise(Effect.provide(program, layer()));
    expect(r.s.providers).toHaveLength(0);
    expect(r.s.tiers.standard).toBeNull();
    expect(Option.isNone(r.key)).toBe(true);
  });
});

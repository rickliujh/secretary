import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { proxyFromSettings } from ".";

const run = (
  network: Partial<ReturnType<typeof defaultSettings>["network"]>,
  secrets: Record<string, string> = {},
) =>
  Effect.runPromise(
    Effect.provide(
      proxyFromSettings,
      Layer.mergeAll(
        makeSettingsTest({
          ...defaultSettings(),
          network: { ...defaultSettings().network, ...network },
        }),
        makeSecretsTest(secrets),
      ),
    ),
  );

describe("proxy settings", () => {
  test("system mode leaves proxy discovery to the HTTP client", async () => {
    expect(await run({ proxyMode: "system", proxyUrl: "http://proxy:8080" })).toBeUndefined();
  });

  test("manual mode passes the proxy, bypass list and keychain password", async () => {
    expect(
      await run(
        {
          proxyMode: "manual",
          proxyUrl: "http://127.0.0.1:9000",
          noProxy: "localhost,127.0.0.1",
          proxyUsername: "rick",
        },
        { [secretNames.proxyPassword]: "proxy-secret-1" },
      ),
    ).toEqual({
      all: {
        url: "http://127.0.0.1:9000",
        noProxy: "localhost,127.0.0.1",
        basicAuth: { username: "rick", password: "proxy-secret-1" },
      },
    });
  });

  test("manual mode without login sends no credentials", async () => {
    expect(await run({ proxyMode: "manual", proxyUrl: "http://proxy:3128", noProxy: "" })).toEqual({
      all: { url: "http://proxy:3128" },
    });
  });
});

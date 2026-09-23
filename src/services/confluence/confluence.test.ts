import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeFetcherTest } from "@/services/http";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import current from "@/test/fixtures/confluence/user-current.json";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";
import { ConfluenceClient, type ConfluenceError } from ".";
import { ConfluenceClientLive } from "./live";

function run(routes: StubRoute[]) {
  const stub = stubFetch(routes);
  const layer = ConfluenceClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeSettingsTest({
          ...defaultSettings(),
          confluence: { baseUrl: "https://wiki.example.com" },
        }),
        makeSecretsTest({ [secretNames.confluencePat]: "conf-pat-123456" }),
        makeFetcherTest(stub.fetch),
      ),
    ),
  );
  const exit = Effect.runPromiseExit(
    Effect.provide(
      Effect.flatMap(ConfluenceClient, (c) => c.testConnection()),
      layer,
    ),
  );
  return { exit, seen: stub.seen };
}

const route = (body: unknown): StubRoute => ({
  match: (url) => url.pathname === "/rest/api/user/current",
  respond: () => json(body),
});

describe("ConfluenceClient.testConnection", () => {
  test("returns the current user", async () => {
    const { exit, seen } = run([route(current)]);
    const result = await exit;
    expect(result._tag === "Success" && result.value.displayName).toBe("Rick Liu");
    expect(seen[0]?.headers.authorization).toBe("Bearer conf-pat-123456");
  });

  test("an anonymous user means the token was not accepted", async () => {
    const { exit } = run([route({ type: "anonymous", displayName: "Anonymous" })]);
    const result = await exit;
    expect(
      result._tag === "Failure" &&
        result.cause._tag === "Fail" &&
        (result.cause.error as ConfluenceError).kind,
    ).toBe("auth");
  });
});

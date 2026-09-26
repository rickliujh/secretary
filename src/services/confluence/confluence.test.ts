import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeFetcherTest } from "@/services/http";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import pageJson from "@/test/fixtures/confluence/page-65601.json";
import search from "@/test/fixtures/confluence/search.json";
import current from "@/test/fixtures/confluence/user-current.json";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";
import { ConfluenceClient, type ConfluenceError } from ".";
import { textToCql, webUrl } from "./cql";
import { ConfluenceClientLive } from "./live";

function run(routes: StubRoute[]) {
  const stub = stubFetch(routes);
  const layer = ConfluenceClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeSettingsTest({
          ...defaultSettings(),
          confluence: { ...defaultSettings().confluence, baseUrl: "https://wiki.example.com" },
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

describe("ConfluenceClient search and page", () => {
  test("search sends CQL with expansions; page fetch expands the storage body", async () => {
    const stub = stubFetch([
      { match: (u) => u.pathname === "/rest/api/content/search", respond: () => json(search) },
      { match: (u) => u.pathname === "/rest/api/content/65601", respond: () => json(pageJson) },
    ]);
    const layer = ConfluenceClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          makeSettingsTest({
            ...defaultSettings(),
            confluence: { ...defaultSettings().confluence, baseUrl: "https://wiki.example.com/" },
          }),
          makeSecretsTest({ [secretNames.confluencePat]: "conf-pat-123456" }),
          makeFetcherTest(stub.fetch),
        ),
      ),
    );
    const cql = textToCql('payments "team"', "PAY");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const c = yield* ConfluenceClient;
          return { found: yield* c.search(cql ?? ""), page: yield* c.getPage("65601") };
        }),
        layer,
      ),
    );
    expect(cql).toBe(
      'type = page AND space = "PAY" AND (title ~ "payments \\"team\\"" OR text ~ "payments \\"team\\"")',
    );
    const url = new URL(stub.seen[0]?.url ?? "");
    expect(url.searchParams.get("cql")).toBe(cql);
    expect(url.searchParams.get("expand")).toBe("space,version");
    expect(r.found.results[0]?.title).toBe("Payments platform team");
    expect(webUrl(r.found.results[0]?._links ?? {}, r.found._links.base ?? "")).toBe(
      "https://wiki.example.com/display/PAY/Payments+platform+team",
    );
    expect(new URL(stub.seen[1]?.url ?? "").searchParams.get("expand")).toBe(
      "body.storage,version,space,ancestors",
    );
    expect(r.page.version.number).toBe(7);
    expect(r.page.body.storage.value).toContain("<h2>What we own</h2>");
  });

  test("empty free text produces no query", () => {
    expect(textToCql("   ")).toBeNull();
  });
});

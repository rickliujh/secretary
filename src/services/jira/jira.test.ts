import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeFetcherTest } from "@/services/http";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import myself from "@/test/fixtures/jira/myself.json";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";
import { JiraClient, type JiraError } from ".";
import { JiraClientLive } from "./live";

const BASE = "https://jira.example.com/jira";

function run(routes: StubRoute[], opts: { baseUrl?: string; pat?: string } = {}) {
  const stub = stubFetch(routes);
  const settings = defaultSettings();
  const layer = JiraClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeSettingsTest({
          ...settings,
          jira: { ...settings.jira, baseUrl: opts.baseUrl ?? BASE },
        }),
        makeSecretsTest(
          opts.pat === "" ? {} : { [secretNames.jiraPat]: opts.pat ?? "stored-pat-123456" },
        ),
        makeFetcherTest(stub.fetch),
      ),
    ),
  );
  const exit = (overrides?: { baseUrl?: string; pat?: string }) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(JiraClient, (c) => c.testConnection(overrides)),
        layer,
      ),
    );
  return { exit, seen: stub.seen };
}

const myselfRoute = (respond: () => Response): StubRoute => ({
  match: (url) => url.pathname === "/jira/rest/api/2/myself",
  respond,
});

const errorOf = (exit: Awaited<ReturnType<ReturnType<typeof run>["exit"]>>) =>
  exit._tag === "Failure" && exit.cause._tag === "Fail"
    ? (exit.cause.error as JiraError)
    : undefined;

describe("JiraClient.testConnection", () => {
  test("returns the display name using the stored bearer PAT and context path", async () => {
    const { exit, seen } = run([myselfRoute(() => json(myself))]);
    const result = await exit();
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.value.displayName).toBe("Rick Liu");
    expect(seen[0]?.url).toBe("https://jira.example.com/jira/rest/api/2/myself");
    expect(seen[0]?.headers.authorization).toBe("Bearer stored-pat-123456");
  });

  test("form values override stored ones", async () => {
    const { exit, seen } = run([
      { match: (url) => url.host === "other.example.com", respond: () => json(myself) },
    ]);
    await exit({ baseUrl: "https://other.example.com/", pat: "typed-pat-000000" });
    expect(seen[0]?.url).toBe("https://other.example.com/rest/api/2/myself");
    expect(seen[0]?.headers.authorization).toBe("Bearer typed-pat-000000");
  });

  test("401 maps to an auth error", async () => {
    const { exit } = run([myselfRoute(() => new Response("", { status: 401 }))]);
    expect(errorOf(await exit())?.kind).toBe("auth");
  });

  test("an SSO login page maps to a decode error with a hint", async () => {
    const { exit } = run([
      myselfRoute(() => new Response("<html><body>Log in</body></html>", { status: 200 })),
    ]);
    const error = errorOf(await exit());
    expect(error?.kind).toBe("decode");
    expect(error?.message).toContain("context path");
  });

  test("server errors map to http errors with status", async () => {
    const { exit } = run([myselfRoute(() => new Response("boom", { status: 400 }))]);
    const error = errorOf(await exit());
    expect(error?.kind).toBe("http");
    expect(error?.status).toBe(400);
  });

  test("network failures map to network errors", async () => {
    const { exit } = run([
      myselfRoute(() => {
        throw new TypeError("fetch failed");
      }),
    ]);
    expect(errorOf(await exit())?.kind).toBe("network");
  });

  test("missing PAT is a not_configured error and makes no request", async () => {
    const { exit, seen } = run([myselfRoute(() => json(myself))], { pat: "" });
    expect(errorOf(await exit())?.kind).toBe("not_configured");
    expect(seen).toHaveLength(0);
  });
});

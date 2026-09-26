import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { redact } from "@/lib/redact";
import { getHeaders, Secrets, secretNames } from ".";
import { makeSecretsTest } from "./test";

describe("Secrets", () => {
  test("set, get and remove through the service", async () => {
    const program = Effect.gen(function* () {
      const s = yield* Secrets;
      yield* s.set(secretNames.jiraPat, "pat-value-123456");
      const got = yield* s.get(secretNames.jiraPat);
      yield* s.remove(secretNames.jiraPat);
      const after = yield* s.get(secretNames.jiraPat);
      return { got, after };
    });
    const { got, after } = await Effect.runPromise(Effect.provide(program, makeSecretsTest()));
    expect(Option.getOrNull(got)).toBe("pat-value-123456");
    expect(Option.isNone(after)).toBe(true);
  });

  test("values written to the keychain are redacted from later text", async () => {
    const program = Effect.flatMap(Secrets, (s) => s.set("llm.p1.api-key", "my-api-key-abcdef"));
    await Effect.runPromise(Effect.provide(program, makeSecretsTest()));
    expect(redact("failed: my-api-key-abcdef")).toBe("failed: [redacted]");
  });

  test("provider headers decode from JSON and tolerate bad data", async () => {
    const good = await Effect.runPromise(
      Effect.provide(
        getHeaders("p1"),
        makeSecretsTest({ [secretNames.providerHeaders("p1")]: '{"X-Proxy":"a","n":1}' }),
      ),
    );
    expect(good).toEqual({ "X-Proxy": "a" });
    const bad = await Effect.runPromise(
      Effect.provide(
        getHeaders("p1"),
        makeSecretsTest({ [secretNames.providerHeaders("p1")]: "not json" }),
      ),
    );
    expect(bad).toEqual({});
  });
});

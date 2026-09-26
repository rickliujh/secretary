import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { redact } from "@/lib/redact";
import { secretNames } from ".";
import { type KeychainIpc, makeKeychainSecrets, VAULT_ENTRY } from "./live";

/** An in-memory keychain that counts reads per entry, like macOS prompts would. */
function fakeKeychain(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const reads = new Map<string, number>();
  const ipc: KeychainIpc = {
    get: async (name) => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return store.get(name) ?? null;
    },
    set: async (name, value) => {
      store.set(name, value);
    },
    remove: async (name) => {
      store.delete(name);
    },
  };
  return { ipc, store, reads };
}

const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e);

describe("one keychain entry for every secret (D32)", () => {
  test("many secrets read at once cost one keychain read", async () => {
    const k = fakeKeychain({
      [VAULT_ENTRY]: JSON.stringify({
        v: 1,
        secrets: { [secretNames.jiraPat]: "jira-token-123456", "llm.p1.api-key": "sk-key-abcdef" },
        moved: [secretNames.jiraPat, "llm.p1.api-key", secretNames.confluencePat],
      }),
    });
    const s = makeKeychainSecrets(k.ipc);
    const [jira, key, conf] = await Promise.all([
      run(s.get(secretNames.jiraPat)),
      run(s.get("llm.p1.api-key")),
      run(s.get(secretNames.confluencePat)),
    ]);
    expect(Option.getOrNull(jira)).toBe("jira-token-123456");
    expect(Option.getOrNull(key)).toBe("sk-key-abcdef");
    expect(Option.isNone(conf)).toBe(true);
    expect([...k.reads]).toEqual([[VAULT_ENTRY, 1]]);
    expect(redact("token jira-token-123456")).toBe("token [redacted]");
  });

  test("a secret stored the old way moves into the vault once, and its old entry goes", async () => {
    const k = fakeKeychain({ [secretNames.jiraPat]: "old-jira-token-9876" });
    const first = makeKeychainSecrets(k.ipc);
    expect(Option.getOrNull(await run(first.get(secretNames.jiraPat)))).toBe("old-jira-token-9876");
    expect(k.store.has(secretNames.jiraPat)).toBe(false);
    // A missing old entry is looked up once, not on every run.
    expect(Option.isNone(await run(first.get(secretNames.proxyPassword)))).toBe(true);

    // Next run: only the vault is read.
    k.reads.clear();
    const second = makeKeychainSecrets(k.ipc);
    expect(Option.getOrNull(await run(second.get(secretNames.jiraPat)))).toBe(
      "old-jira-token-9876",
    );
    expect(Option.isNone(await run(second.get(secretNames.proxyPassword)))).toBe(true);
    expect([...k.reads]).toEqual([[VAULT_ENTRY, 1]]);
  });

  test("set and remove rewrite the vault; concurrent writes are all kept", async () => {
    const k = fakeKeychain();
    const s = makeKeychainSecrets(k.ipc);
    await Promise.all([
      run(s.set("llm.a.api-key", "key-a-111111")),
      run(s.set("llm.b.api-key", "key-b-222222")),
      run(s.set(secretNames.jiraPat, "jira-333333")),
    ]);
    await run(s.remove("llm.a.api-key"));
    const stored = JSON.parse(k.store.get(VAULT_ENTRY) ?? "{}");
    expect(stored.secrets).toEqual({
      "llm.b.api-key": "key-b-222222",
      [secretNames.jiraPat]: "jira-333333",
    });
    expect(Option.isNone(await run(s.get("llm.a.api-key")))).toBe(true);
  });

  test("a denied keychain read is an error and is retried next time", async () => {
    const k = fakeKeychain();
    let deny = true;
    const ipc: KeychainIpc = {
      ...k.ipc,
      get: async (name) => {
        if (deny) throw new Error("User canceled the operation.");
        return k.ipc.get(name);
      },
    };
    const s = makeKeychainSecrets(ipc);
    const denied = await Effect.runPromise(Effect.either(s.get(secretNames.jiraPat)));
    expect(denied._tag).toBe("Left");
    deny = false;
    expect(Option.isNone(await run(s.get(secretNames.jiraPat)))).toBe(true);
  });
});

import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Option } from "effect";
import { z } from "zod";
import { forgetSecret, redact, registerSecret } from "@/lib/redact";
import { Secrets, SecretsError, type SecretsShape } from ".";

/** The keychain calls, injectable for tests. */
export type KeychainIpc = {
  get: (name: string) => Promise<string | null>;
  set: (name: string, value: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
};

const tauriKeychain: KeychainIpc = {
  get: (name) => invoke<string | null>("secret_get", { name }),
  set: (name, value) => invoke<void>("secret_set", { name, value }),
  remove: (name) => invoke<void>("secret_delete", { name }),
};

/** The single keychain entry holding every secret (design.md D32). */
export const VAULT_ENTRY = "vault";

const VaultSchema = z.object({
  v: z.literal(1),
  secrets: z.record(z.string(), z.string()),
  /** Names already looked up as separate, older keychain entries. */
  moved: z.array(z.string()),
});
type Vault = z.infer<typeof VaultSchema>;

const fail = (name: string) => (cause: unknown) =>
  new SecretsError({ name, message: redact(String(cause)) });

/**
 * Every secret in one keychain entry, so macOS asks once (and not again after
 * "Always Allow") instead of once per secret. The entry is read once per run
 * and kept in memory; writes are serialised and rewrite the whole entry. A
 * secret stored the old way, as its own entry, is moved in the first time it is
 * asked for, then its old entry is deleted.
 */
export function makeKeychainSecrets(ipc: KeychainIpc): SecretsShape {
  let loaded: Promise<Vault> | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  const load = () => {
    loaded ??= ipc.get(VAULT_ENTRY).then((raw) => {
      let vault: Vault = { v: 1, secrets: {}, moved: [] };
      if (raw) {
        try {
          const parsed = VaultSchema.safeParse(JSON.parse(raw));
          if (parsed.success) vault = parsed.data;
        } catch {
          // An unreadable vault starts empty; old entries are moved in again.
        }
      }
      for (const value of Object.values(vault.secrets)) registerSecret(value);
      return vault;
    });
    // A failed read (e.g. the prompt was denied) is retried next time.
    loaded.catch(() => {
      loaded = null;
    });
    return loaded;
  };

  /** Applies `change` and saves the vault, one write at a time. */
  const update = (change: (v: Vault) => void) => {
    const next = writes.then(async () => {
      const vault = await load();
      change(vault);
      await ipc.set(VAULT_ENTRY, JSON.stringify(vault));
    });
    writes = next.catch(() => undefined);
    return next;
  };

  const get = async (name: string): Promise<string | null> => {
    const vault = await load();
    if (name in vault.secrets) return vault.secrets[name] ?? null;
    if (vault.moved.includes(name)) return null;
    // Stored before D32 as its own entry: move it into the vault once.
    const old = await ipc.get(name);
    await update((v) => {
      if (old) v.secrets[name] = old;
      v.moved.push(name);
    });
    if (old) {
      registerSecret(old);
      await ipc.remove(name).catch(() => undefined);
    }
    return old;
  };

  return {
    get: (name) =>
      Effect.tryPromise({ try: () => get(name), catch: fail(name) }).pipe(
        Effect.map(Option.fromNullable),
      ),
    set: (name, value) =>
      Effect.sync(() => registerSecret(value)).pipe(
        Effect.zipRight(
          Effect.tryPromise({
            try: () =>
              update((v) => {
                v.secrets[name] = value;
                if (!v.moved.includes(name)) v.moved.push(name);
              }),
            catch: fail(name),
          }),
        ),
      ),
    remove: (name) =>
      Effect.tryPromise({
        try: async () => {
          const vault = await load();
          forgetSecret(vault.secrets[name]);
          await update((v) => {
            delete v.secrets[name];
            if (!v.moved.includes(name)) v.moved.push(name);
          });
          await ipc.remove(name).catch(() => undefined);
        },
        catch: fail(name),
      }),
  };
}

export const SecretsLive = Layer.sync(Secrets, () => makeKeychainSecrets(tauriKeychain));

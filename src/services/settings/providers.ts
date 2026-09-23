/**
 * Provider create/update/delete. Settings get the non-secret fields; the API key
 * and header values go to the keychain (design.md D12).
 */
import { Effect, Option } from "effect";
import { newId } from "@/lib/ids";
import { getHeaders, Secrets, secretNames } from "@/services/secrets";
import { type Provider, ProviderSchema, Settings } from ".";

export type ProviderInput = Omit<Provider, "id" | "headerNames"> & {
  id?: string;
  /** Blank keeps the stored key. */
  apiKey?: string;
  /** Header names to drop from the stored set. */
  removeHeaders?: string[];
  /** Headers to add or replace. */
  addHeaders?: Record<string, string>;
};

/** Parses "Name: value" lines. Returns errors for malformed lines. */
export function parseHeaderLines(text: string): {
  headers: Record<string, string>;
  errors: string[];
} {
  const headers: Record<string, string> = {};
  const errors: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    const name = idx > 0 ? line.slice(0, idx).trim() : "";
    const value = idx > 0 ? line.slice(idx + 1).trim() : "";
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || !value) {
      errors.push(`Line ${i + 1}: expected "Name: value"`);
      continue;
    }
    headers[name] = value;
  }
  return { headers, errors };
}

export const saveProvider = (input: ProviderInput) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const secrets = yield* Secrets;
    const id = input.id ?? newId();

    const existing = yield* getHeaders(id);
    const merged = { ...existing };
    for (const name of input.removeHeaders ?? []) delete merged[name];
    Object.assign(merged, input.addHeaders ?? {});
    const headerNames = Object.keys(merged).sort();

    const { apiKey, removeHeaders: _r, addHeaders: _a, ...fields } = input;
    const provider = ProviderSchema.parse({ ...fields, id, headerNames });

    // Keychain first: a settings entry must never point at secrets that failed to save.
    if (apiKey?.trim()) yield* secrets.set(secretNames.providerApiKey(id), apiKey.trim());
    if (headerNames.length > 0) {
      yield* secrets.set(secretNames.providerHeaders(id), JSON.stringify(merged));
    } else {
      yield* secrets.remove(secretNames.providerHeaders(id));
    }

    yield* settings.update((s) => ({
      ...s,
      providers: s.providers.some((p) => p.id === id)
        ? s.providers.map((p) => (p.id === id ? provider : p))
        : [...s.providers, provider],
    }));
    return provider;
  });

/** Removes the provider, its keychain entries and any tier bound to it. */
export const deleteProvider = (id: string) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const secrets = yield* Secrets;
    yield* settings.update((s) => {
      const unbind = (b: typeof s.tiers.fast) => (b?.providerId === id ? null : b);
      return {
        ...s,
        providers: s.providers.filter((p) => p.id !== id),
        tiers: {
          fast: unbind(s.tiers.fast),
          standard: unbind(s.tiers.standard),
          strong: unbind(s.tiers.strong),
        },
      };
    });
    yield* secrets.remove(secretNames.providerApiKey(id));
    yield* secrets.remove(secretNames.providerHeaders(id));
  });

/** Whether a keychain entry exists. The value is not returned to the caller. */
export const hasSecret = (name: string) =>
  Effect.flatMap(Secrets, (s) => s.get(name)).pipe(Effect.map(Option.isSome));

import { isTauri } from "@tauri-apps/api/core";
import { Context, Effect, Layer, Option } from "effect";
import { logger } from "@/lib/log";
import { redact } from "@/lib/redact";
import { Secrets, secretNames } from "@/services/secrets";
import { Settings } from "@/services/settings";

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The fetch used for every outbound request. In the app this is the
 * plugin-http fetch (no CORS, scoped by capabilities, OS trust store); tests
 * inject a stub.
 */
export class Fetcher extends Context.Tag("Fetcher")<Fetcher, { readonly fetch: FetchFn }>() {}

type ProxyConfig = {
  all: { url: string; noProxy?: string; basicAuth?: { username: string; password: string } };
};

/** Manual proxy from settings, or undefined to let the HTTP client use the system/env proxy. */
export const proxyFromSettings = Effect.gen(function* () {
  const settings = yield* (yield* Settings).get.pipe(Effect.orElseSucceed(() => undefined));
  const net = settings?.network;
  if (!net || net.proxyMode !== "manual" || !net.proxyUrl) return undefined;
  const password = net.proxyUsername
    ? Option.getOrUndefined(
        yield* (yield* Secrets)
          .get(secretNames.proxyPassword)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      )
    : undefined;
  return {
    all: {
      url: net.proxyUrl,
      ...(net.noProxy.trim() ? { noProxy: net.noProxy.trim() } : {}),
      ...(net.proxyUsername && password
        ? { basicAuth: { username: net.proxyUsername, password } }
        : {}),
    },
  } satisfies ProxyConfig;
});

export const FetcherLive = Layer.effect(
  Fetcher,
  Effect.gen(function* () {
    if (!isTauri())
      return { fetch: (input, init) => globalThis.fetch(input, init) } satisfies { fetch: FetchFn };
    const settings = yield* Settings;
    const secrets = yield* Secrets;
    const proxy = () =>
      Effect.runPromise(
        proxyFromSettings.pipe(
          Effect.provideService(Settings, settings),
          Effect.provideService(Secrets, secrets),
        ),
      );
    const tauriFetch: FetchFn = async (input, init) => {
      const { fetch: pluginFetch } = await import("@tauri-apps/plugin-http");
      // plugin-http only wires cancellation from `init.signal`; ky passes a Request
      // whose own signal carries timeouts and aborts, so forward it.
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const url = input instanceof Request ? input.url : String(input);
      try {
        return await pluginFetch(input, { ...init, signal, proxy: await proxy() });
      } catch (error) {
        // The toast shows a short message; the log keeps the details for diagnosis.
        logger.warn(
          `Request failed: ${url.split("?")[0]}`,
          redact(error instanceof Error ? error.message : String(error)),
        );
        throw error;
      }
    };
    return { fetch: tauriFetch };
  }),
);

export const makeFetcherTest = (fetchImpl: FetchFn) => Layer.succeed(Fetcher, { fetch: fetchImpl });

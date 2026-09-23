import { isTauri } from "@tauri-apps/api/core";
import { Context, Layer } from "effect";

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The fetch used for every outbound request. In the app this is the
 * plugin-http fetch (no CORS, scoped by capabilities); tests inject a stub.
 */
export class Fetcher extends Context.Tag("Fetcher")<Fetcher, { readonly fetch: FetchFn }>() {}

export const FetcherLive = Layer.sync(Fetcher, () => {
  if (!isTauri())
    return { fetch: (input, init) => globalThis.fetch(input, init) } satisfies {
      fetch: FetchFn;
    };
  const tauriFetch: FetchFn = async (input, init) => {
    const { fetch: pluginFetch } = await import("@tauri-apps/plugin-http");
    // plugin-http only wires cancellation from `init.signal`; ky passes a Request
    // whose own signal carries timeouts and aborts, so forward it.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return pluginFetch(input, { ...init, signal });
  };
  return { fetch: tauriFetch };
});

export const makeFetcherTest = (fetchImpl: FetchFn) => Layer.succeed(Fetcher, { fetch: fetchImpl });

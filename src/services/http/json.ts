/**
 * JSON over HTTP for the Atlassian clients: `ky` on the injected fetch, bearer
 * auth, zod-validated responses (design.md D11).
 */
import ky, { HTTPError, type KyInstance, TimeoutError } from "ky";
import type { z } from "zod";
import { redact } from "@/lib/redact";
import type { FetchFn } from ".";

export type HttpFailureKind = "auth" | "http" | "network" | "timeout" | "decode";

export class HttpFailure extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, "");

export function makeBearerClient(opts: {
  baseUrl: string;
  apiPrefix: string;
  token: string;
  fetch: FetchFn;
  timeoutMs?: number;
}): KyInstance {
  return ky.create({
    prefix: `${normalizeBaseUrl(opts.baseUrl)}${opts.apiPrefix}`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/json",
      // Stops Jira/Confluence from answering XSRF checks with a login page.
      "X-Atlassian-Token": "no-check",
    },
    timeout: opts.timeoutMs ?? 30_000,
    retry: { limit: 1, methods: ["get"], statusCodes: [408, 429, 500, 502, 503, 504] },
    fetch: opts.fetch as typeof globalThis.fetch,
  });
}

const HTML_HINT =
  "The server answered with HTML instead of JSON. Check the base URL (include any context path such as /jira) and that personal access tokens are enabled.";

async function describeHttpError(error: HTTPError): Promise<HttpFailure> {
  const status = error.response.status;
  let detail = "";
  try {
    detail = (await error.response.clone().text()).slice(0, 300);
  } catch {
    // body unavailable
  }
  if (status === 401 || status === 403) {
    return new HttpFailure(
      "auth",
      `The server rejected the token (${status}). Check the PAT and that it has not expired.`,
      status,
    );
  }
  const text = /<html/i.test(detail) ? HTML_HINT : redact(detail) || error.message;
  return new HttpFailure("http", `HTTP ${status}: ${text}`, status);
}

/** Performs a request and validates the JSON body. Throws `HttpFailure`. */
export async function requestJson<T>(
  client: KyInstance,
  path: string,
  schema: z.ZodType<T>,
  options: Parameters<KyInstance>[1] = {},
): Promise<T> {
  let response: Response;
  try {
    response = await client(path, options);
  } catch (error) {
    if (error instanceof HTTPError) throw await describeHttpError(error);
    if (error instanceof TimeoutError)
      throw new HttpFailure("timeout", "The server did not respond in time.");
    throw new HttpFailure(
      "network",
      `Could not reach the server: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
  const body = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new HttpFailure("decode", /<html/i.test(body) ? HTML_HINT : "The response was not JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpFailure(
      "decode",
      `Unexpected response shape: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

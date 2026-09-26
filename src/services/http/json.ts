/**
 * JSON over HTTP for the Atlassian clients: `ky` on the injected fetch, bearer
 * auth, zod-validated responses (design.md D11).
 */
import ky, { HTTPError, type KyInstance, TimeoutError } from "ky";
import type { z } from "zod";
import { redact } from "@/lib/redact";
import { trimBaseUrl } from "@/lib/url";
import { type AtlassianAuth, authorizationHeader } from "@/services/atlassian/deployment";
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

export function makeAtlassianClient(opts: {
  /** API root, already resolved for the deployment (see atlassian/deployment.ts). */
  baseUrl: string;
  apiPrefix: string;
  auth: AtlassianAuth;
  fetch: FetchFn;
  timeoutMs?: number;
}): KyInstance {
  return ky.create({
    prefix: `${trimBaseUrl(opts.baseUrl)}${opts.apiPrefix}`,
    headers: {
      Authorization: authorizationHeader(opts.auth),
      Accept: "application/json",
      // Stops Jira/Confluence from answering XSRF checks with a login page.
      "X-Atlassian-Token": "no-check",
    },
    timeout: opts.timeoutMs ?? 30_000,
    // Cloud rate limits answer 429 with Retry-After, which ky honours between attempts.
    retry: {
      limit: 3,
      methods: ["get"],
      statusCodes: [408, 429, 500, 502, 503, 504],
      backoffLimit: 30_000,
    },
    fetch: opts.fetch as typeof globalThis.fetch,
  });
}

const HTML_HINT =
  "The server answered with HTML instead of JSON. Check the base URL (include any context path such as /jira) and that personal access tokens are enabled.";

/** Jira and Confluence report errors as `{ errorMessages: [], errors: { field: msg } }` or `{ message }`. */
function atlassianErrorText(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as { errorMessages?: unknown; errors?: unknown; message?: unknown };
  const parts: string[] = [];
  if (Array.isArray(d.errorMessages))
    parts.push(...d.errorMessages.filter((m): m is string => typeof m === "string"));
  if (d.errors && typeof d.errors === "object") {
    for (const [field, msg] of Object.entries(d.errors))
      if (typeof msg === "string") parts.push(`${field}: ${msg}`);
  }
  if (typeof d.message === "string") parts.push(d.message);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

async function describeHttpError(error: HTTPError): Promise<HttpFailure> {
  const status = error.response.status;
  // ky has usually consumed the body into `data` already.
  let detail = typeof error.data === "string" ? error.data : (atlassianErrorText(error.data) ?? "");
  if (!detail && error.data === undefined) {
    try {
      detail = await error.response.clone().text();
    } catch {
      // body unavailable
    }
  }
  const parsed = (() => {
    try {
      return atlassianErrorText(JSON.parse(detail));
    } catch {
      return undefined;
    }
  })();
  detail = (parsed ?? detail).slice(0, 500);
  if (status === 401 || status === 403) {
    return new HttpFailure(
      "auth",
      `The server rejected the credentials (${status}). Check the token (and on Cloud the account email) and that the token has not expired.`,
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
      `Could not reach the server: ${redact(error instanceof Error ? error.message : String(error))}. If you are behind a company proxy, set it in Settings > General > Network.`,
    );
  }
  const body = await response.text();
  let json: unknown;
  try {
    // 204 and other empty bodies decode as null; the schema decides if that is valid.
    json = body.trim() === "" ? null : JSON.parse(body);
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

/**
 * Secret redaction for anything that may reach logs, errors shown in the UI, or
 * exports (design.md section 9). Values read from or written to the keychain are
 * registered here, so any later string containing them is scrubbed.
 */

const REDACTED = "[redacted]";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

// Secrets shorter than this are not registered: replacing short, common strings
// would mangle ordinary text and a short value is not a meaningful credential.
const MIN_SECRET_LENGTH = 6;

const knownSecrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) knownSecrets.add(value);
}

export function forgetSecret(value: string | null | undefined): void {
  if (value) knownSecrets.delete(value);
}

/** Test hook. */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const KEY_LIKE_PATTERN = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,})/g;

export function redact(text: string): string {
  let out = text;
  // Longest first so a secret that contains another is replaced whole.
  const secrets = [...knownSecrets].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED);
  }
  return out.replace(BEARER_PATTERN, `$1 ${REDACTED}`).replace(KEY_LIKE_PATTERN, REDACTED);
}

export function redactHeaders(
  headers: Record<string, string> | Headers | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [name, value] of entries) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : redact(value);
  }
  return out;
}

/** Deep-redacts strings inside a JSON-like value, and blanks sensitive header keys. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : redactValue(v);
    }
    return out as T;
  }
  return value;
}

import type { z } from "zod";

/**
 * Reads JSON stored as text (sync state, cached briefs, raw Jira JSON). A value
 * that is missing, malformed or does not match `schema` gives `fallback`.
 * Schemas should be lenient (defaults, optional fields) so values written by
 * older versions still load.
 */
export function readJson<S extends z.ZodType>(
  value: unknown,
  schema: S,
  fallback: z.output<S>,
): z.output<S> {
  if (typeof value !== "string" || !value) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fallback;
  }
  const r = schema.safeParse(parsed);
  return r.success ? r.data : fallback;
}

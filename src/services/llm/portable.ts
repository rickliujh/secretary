/**
 * Portable structured-output schemas (design.md D21). Providers differ in how
 * much JSON Schema they honour: some structured-output modes (for example
 * Gemini, and proxies translating to it) collapse `anyOf` to its first branch
 * and cannot express `null`. The model therefore sees a schema without `anyOf`,
 * `oneOf`, `const` or `null`: nullable fields become required, an empty string
 * means "none", and enums gain "" as a choice. Replies are mapped back ("" ->
 * null where the real schema allows null) and validated with the real zod schema.
 */
import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

type Json = { [key: string]: unknown };

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isNull = (v: unknown) => isObject(v) && v.type === "null";

/**
 * The schema without its null choice when `node` is nullable, either as
 * `anyOf: [X, {type: "null"}]` or as `type: [X, "null"]`.
 */
function nullableBranch(node: Json): Json | undefined {
  if (Array.isArray(node.type) && node.type.includes("null")) {
    const types = node.type.filter((t) => t !== "null");
    const { enum: values, ...rest } = node;
    return {
      ...rest,
      type: types.length === 1 ? types[0] : types,
      ...(Array.isArray(values) ? { enum: values.filter((v) => v !== null) } : {}),
    };
  }
  const any = node.anyOf;
  if (!Array.isArray(any) || any.length !== 2 || !any.some(isNull)) return undefined;
  const other = any.find((b) => !isNull(b));
  return isObject(other) ? other : undefined;
}

function allowsEmpty(node: Json): Json {
  if (Array.isArray(node.enum))
    return node.enum.includes("") ? node : { ...node, enum: [...node.enum, ""] };
  if (node.type === "string") {
    const hint = "Empty string when not applicable.";
    return { ...node, description: node.description ? `${node.description} ${hint}` : hint };
  }
  return node;
}

export function portableSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(portableSchema);
  if (!isObject(node)) return node;
  const inner = nullableBranch(node);
  if (inner) {
    const { anyOf: _drop, type: _type, enum: _enum, ...rest } = node;
    const merged = { ...rest, ...(portableSchema(inner) as Json) };
    // A nullable string or enum can say "none" with "". Other types keep their shape.
    return merged.type === "string" || Array.isArray(merged.enum) ? allowsEmpty(merged) : merged;
  }
  if (isNull(node))
    return {
      type: "string",
      enum: [""],
      ...(node.description ? { description: node.description } : {}),
    };
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "required" && isObject(node.properties)) continue;
    if (k === "const") {
      out.enum = [v];
      continue;
    }
    if (k === "properties" && isObject(v)) {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([p, s]) => [p, portableSchema(s)]),
      );
      // Strict modes want every property listed; "" or [] stands for "not given".
      out.required = Object.keys(v);
      continue;
    }
    out[k] = portableSchema(v);
  }
  return out;
}

/** Maps "" back to null wherever the original schema allows null. */
export function emptyToNull(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value;
  const inner = nullableBranch(schema);
  if (inner) return value === "" ? null : emptyToNull(value, inner);
  if (isNull(schema)) return value === "" ? null : value;
  if (Array.isArray(value))
    return isObject(schema.items) ? value.map((v) => emptyToNull(v, schema.items)) : value;
  if (isObject(value) && isObject(schema.properties)) {
    const props = schema.properties;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, emptyToNull(v, props[k])]));
  }
  return value;
}

/**
 * The AI SDK output schema for a zod schema: the model sees the portable form,
 * and replies are mapped back and parsed with the zod schema itself.
 */
export function portableOutputSchema<T>(schema: z.ZodType<T>): Schema<T> {
  // Same conversion options as the AI SDK's own zod adapter.
  const real = z.toJSONSchema(schema, { target: "draft-7", io: "input", reused: "inline" });
  return jsonSchema<T>(portableSchema(real) as Parameters<typeof jsonSchema>[0], {
    validate: (value) => {
      const r = schema.safeParse(emptyToNull(value, real));
      return r.success ? { success: true, value: r.data } : { success: false, error: r.error };
    },
  });
}

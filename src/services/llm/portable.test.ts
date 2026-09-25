import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { emptyToNull, portableSchema } from "./portable";

const schema = z.object({
  kind: z.enum(["add_comment"]),
  target: z.enum(["PAY-1", "PAY-2"]).nullish(),
  body: z.string().nullish(),
  never: z.null(),
  items: z.array(z.object({ note: z.string().nullable() })),
  confidence: z.number(),
});
const json = z.toJSONSchema(schema);

describe("portable schemas", () => {
  test("no anyOf, oneOf, const or null; nullable fields required with empty-string choices", () => {
    const p = portableSchema(json) as {
      properties: Record<string, { enum?: string[]; type?: string }>;
      required: string[];
    };
    const text = JSON.stringify(p);
    for (const k of ['"anyOf"', '"oneOf"', '"const"', '"null"']) expect(text).not.toContain(k);
    expect(p.required.sort()).toEqual(["body", "confidence", "items", "kind", "never", "target"]);
    expect(p.properties.kind?.enum).toEqual(["add_comment"]);
    expect(p.properties.target?.enum).toEqual(["PAY-1", "PAY-2", ""]);
    expect(p.properties.never).toEqual({ type: "string", enum: [""] });
  });

  test("replies map back so the real schema validates them", () => {
    const reply = {
      kind: "add_comment",
      target: "",
      body: "hi",
      never: "",
      items: [{ note: "" }],
      confidence: 0.8,
    };
    expect(schema.parse(emptyToNull(reply, json))).toEqual({
      kind: "add_comment",
      target: null,
      body: "hi",
      never: null,
      items: [{ note: null }],
      confidence: 0.8,
    });
  });

  test("an empty string where null is not allowed stays invalid", () => {
    const strict = z.object({ kind: z.enum(["a"]) });
    expect(strict.safeParse(emptyToNull({ kind: "" }, z.toJSONSchema(strict))).success).toBe(false);
  });
});

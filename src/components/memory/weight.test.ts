import { describe, expect, test } from "bun:test";
import { WEIGHTS } from "@/services/memory/schema";
import { WEIGHT_NAMES, WEIGHT_OPTIONS, weightName } from "./weight";

describe("memory weight names", () => {
  test("presets read as themselves", () => {
    for (const name of WEIGHT_NAMES) expect(weightName(WEIGHTS[name])).toBe(name);
  });

  test("other values read as the nearest end, so card and dialog agree", () => {
    expect(weightName(0.1)).toBe("low");
    expect(weightName(1.5)).toBe("normal");
    expect(weightName(3)).toBe("high");
  });

  test("every name has one option", () => {
    expect(WEIGHT_OPTIONS.map((o) => o.value)).toEqual([...WEIGHT_NAMES]);
  });
});

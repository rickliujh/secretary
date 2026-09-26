import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "./errors";

/** Every TaggedError declared by a service, found in the source. */
function serviceErrorTags(): string[] {
  const root = join(import.meta.dir, "../services");
  const tags = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts"))
        for (const m of readFileSync(p, "utf8").matchAll(/TaggedError\("([A-Za-z]+)"\)/g))
          if (m[1]) tags.add(m[1]);
    }
  };
  walk(root);
  return [...tags].sort();
}

describe("error toasts", () => {
  test.each(serviceErrorTags())("%s has its own title", (tag) => {
    expect(describeError({ _tag: tag, message: "x", kind: "invalid" }).title).not.toBe(
      "Something went wrong",
    );
  });

  test("network failures point to the network settings; secrets are redacted", () => {
    expect(describeError({ _tag: "JiraError", kind: "network", message: "offline" })).toMatchObject(
      {
        title: "Can't reach Jira",
        settingsTab: "general",
      },
    );
    expect(
      describeError({
        _tag: "LlmError",
        kind: "auth",
        message: "bad key sk-ant-abcdefghijklmnopqrstuv",
      }).description,
    ).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
  });
});

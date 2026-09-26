import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "./log";
import { clearRegisteredSecrets, registerSecret } from "./redact";

describe("logger (design.md section 9)", () => {
  afterEach(clearRegisteredSecrets);

  test("keychain values, bearer tokens and API keys never reach the log", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    registerSecret("ATATT3xFfGF0-jira-cloud-token");
    logger.warn("Request failed", {
      headers: { Authorization: "Bearer abcdefghijklmnop123" },
      detail:
        "token ATATT3xFfGF0-jira-cloud-token rejected; key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    });
    await new Promise((r) => setTimeout(r, 0));
    const line = String(warn.mock.calls[0]?.[0]);
    warn.mockRestore();
    expect(line).toContain("Request failed");
    expect(line).not.toContain("ATATT3xFfGF0-jira-cloud-token");
    expect(line).not.toContain("abcdefghijklmnop123");
    expect(line).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });
});

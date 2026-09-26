import { afterEach, describe, expect, test } from "bun:test";
import { allowHost, checkRequest, clearPendingHosts, OFFLINE_MESSAGE } from "./guard";

const config = {
  jiraBaseUrl: "https://acme.atlassian.net",
  confluenceBaseUrl: null,
  providerBaseUrls: ["http://127.0.0.1:8080/v1", "https://openrouter.ai/api/v1"],
};

describe("request guard (D27)", () => {
  afterEach(clearPendingHosts);

  test("configured hosts pass, including a port", () => {
    expect(checkRequest("https://acme.atlassian.net/rest/api/2/myself", config, true)).toBeNull();
    expect(
      checkRequest("https://acme.atlassian.net/wiki/rest/api/search", config, true),
    ).toBeNull();
    expect(checkRequest("http://127.0.0.1:8080/v1/chat/completions", config, true)).toBeNull();
  });

  test("anything else is refused before it leaves the app", () => {
    expect(checkRequest("https://evil.example.com/steal", config, true)).toContain(
      "Refused a request to evil.example.com",
    );
    expect(checkRequest("http://127.0.0.1:9999/v1", config, true)).toContain("127.0.0.1:9999");
  });

  test("a host being tested in settings is allowed before it is saved", () => {
    allowHost("https://new-jira.example.com");
    expect(checkRequest("https://new-jira.example.com/rest/api/2/myself", config, true)).toBeNull();
  });

  test("offline fails fast with a clear message", () => {
    expect(checkRequest("https://acme.atlassian.net/rest/api/2/myself", config, false)).toBe(
      OFFLINE_MESSAGE,
    );
  });
});

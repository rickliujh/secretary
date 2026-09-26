import { describe, expect, test } from "bun:test";
import {
  authorizationHeader,
  confluenceApiBase,
  jiraApiBase,
  resolveDeployment,
} from "./deployment";

describe("deployment", () => {
  test("atlassian.net is Cloud unless overridden", () => {
    expect(resolveDeployment("https://acme.atlassian.net/jira")).toBe("cloud");
    expect(resolveDeployment("https://jira.acme.com")).toBe("datacenter");
    expect(resolveDeployment("https://jira.acme.com", "cloud")).toBe("cloud");
    expect(resolveDeployment("not a url")).toBe("datacenter");
  });

  test("Cloud API bases ignore UI paths; Data Center keeps its context path", () => {
    expect(jiraApiBase("https://acme.atlassian.net/jira/software/projects/PAY", "cloud")).toBe(
      "https://acme.atlassian.net",
    );
    expect(jiraApiBase("https://host.example.com/jira/", "datacenter")).toBe(
      "https://host.example.com/jira",
    );
    expect(confluenceApiBase("https://acme.atlassian.net", "cloud")).toBe(
      "https://acme.atlassian.net/wiki",
    );
    expect(confluenceApiBase("https://acme.atlassian.net/wiki/spaces/PAY", "cloud")).toBe(
      "https://acme.atlassian.net/wiki",
    );
  });

  test("Basic auth for Cloud, Bearer for Data Center", () => {
    expect(authorizationHeader({ type: "basic", email: "rick@example.com", token: "tok" })).toBe(
      `Basic ${btoa("rick@example.com:tok")}`,
    );
    expect(authorizationHeader({ type: "bearer", token: "pat" })).toBe("Bearer pat");
  });
});

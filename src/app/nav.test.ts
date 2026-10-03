import { describe, expect, test } from "bun:test";
import { ALL_PAGES, PAGE_TABS, sidebarNav } from "./nav";

describe("navigation (D50)", () => {
  test("seven pages in the sidebar, without Drafts by default", () => {
    expect(sidebarNav(false).map((n) => n.label)).toEqual([
      "Today",
      "Inbox",
      "Tickets",
      "Waiting on",
      "Sprint",
      "Chat",
      "Context",
    ]);
  });

  test("the setting puts Drafts back before Chat", () => {
    expect(sidebarNav(true).map((n) => n.to)).toEqual([
      "/",
      "/inbox",
      "/tickets",
      "/waiting",
      "/sprint",
      "/drafts",
      "/chat",
      "/context",
    ]);
  });

  test("the palette still reaches Drafts and every tab", () => {
    expect(ALL_PAGES.map((n) => n.to)).toContain("/drafts");
    expect(PAGE_TABS.map((t) => `${t.page} ${t.label}`)).toEqual([
      "Sprint Plan",
      "Sprint Report",
      "Sprint Epics",
      "Context People",
      "Context Teams",
      "Context Memory",
    ]);
  });
});

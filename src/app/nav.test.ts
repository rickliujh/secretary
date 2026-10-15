import { describe, expect, test } from "bun:test";
import { ALL_PAGES, MAIN_NAV, PAGE_TABS } from "./nav";

describe("navigation (D50)", () => {
  test("eight pages in the sidebar, Drafts before Chat", () => {
    expect(MAIN_NAV.map((n) => n.label)).toEqual([
      "Today",
      "Inbox",
      "Tickets",
      "Waiting on",
      "Sprint",
      "Drafts",
      "Chat",
      "Context",
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

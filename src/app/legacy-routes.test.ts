/**
 * D50: the pages folded into tabs redirect to their tab, keeping their search
 * parameters, and the tab itself is a validated search parameter. Runs the app's
 * real route tree in a memory history; no component renders.
 */
import { describe, expect, mock, test } from "bun:test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";

// Vite bundles the SQL migrations with `import.meta.glob`, which Bun lacks; no route needs them here.
mock.module("@/db/bundled-migrations", () => ({ bundledMigrations: [] }));
const { routeTree } = await import("@/routeTree.gen");

/** Loads `url` and returns where the router ended up, with the validated search. */
async function land(url: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
    // Bun has no `document`, so the router would load as on a server and not follow redirects.
    isServer: false,
    origin: "http://localhost",
  });
  await router.load();
  const leaf = router.state.matches.at(-1);
  return { path: router.state.location.pathname, search: leaf?.search ?? {} };
}

describe("old paths land on the right tab", () => {
  test.each([
    ["/planning", "/sprint", { tab: "plan" }],
    ["/report", "/sprint", { tab: "report" }],
    ["/people", "/context", { tab: "people" }],
    ["/teams", "/context", { tab: "teams" }],
    ["/memory", "/context", { tab: "memory", list: "memories" }],
  ])("%s goes to %s", async (from, to, search) => {
    const r = await land(from);
    expect(r.path).toBe(to);
    expect(r.search).toMatchObject(search);
  });

  test("a contact or team id comes along", async () => {
    expect(await land("/people?id=p1")).toMatchObject({
      path: "/context",
      search: { tab: "people", id: "p1" },
    });
    expect(await land("/teams?id=t1")).toMatchObject({
      path: "/context",
      search: { tab: "teams", id: "t1" },
    });
  });

  test("the Memory page's own tab becomes the list", async () => {
    expect(await land("/memory?tab=corrections")).toMatchObject({
      path: "/context",
      search: { tab: "memory", list: "corrections" },
    });
  });

  test("an open ticket panel stays open", async () => {
    expect(await land("/planning?ticket=PAY-2")).toMatchObject({
      path: "/sprint",
      search: { tab: "plan", ticket: "PAY-2" },
    });
    expect(await land("/people?id=p1&ticket=PAY-2")).toMatchObject({
      search: { tab: "people", id: "p1", ticket: "PAY-2" },
    });
  });
});

describe("settings tabs", () => {
  test("the old Ranking tab opens Advanced", async () => {
    expect((await land("/settings?tab=ranking")).search).toMatchObject({ tab: "advanced" });
    expect((await land("/settings?tab=advanced")).search).toMatchObject({ tab: "advanced" });
    expect((await land("/settings?tab=models")).search).toMatchObject({ tab: "models" });
    expect((await land("/settings?tab=nope")).search).toMatchObject({ tab: "general" });
  });
});

describe("the tab search parameter", () => {
  test("picks the tab", async () => {
    expect((await land("/sprint?tab=epics")).search).toMatchObject({ tab: "epics" });
    expect((await land("/context?tab=memory&list=corrections")).search).toMatchObject({
      tab: "memory",
      list: "corrections",
    });
  });

  test("falls back to the first tab when missing or unknown", async () => {
    expect((await land("/sprint")).search).toMatchObject({ tab: "plan" });
    expect((await land("/sprint?tab=planning")).search).toMatchObject({ tab: "plan" });
    expect((await land("/context")).search).toMatchObject({ tab: "people", list: "memories" });
    expect((await land("/context?tab=nope&list=nope")).search).toMatchObject({
      tab: "people",
      list: "memories",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseProjectMeta, parseSprintState } from "@/services/sync/state";
import { readJson } from "./json";

describe("readJson", () => {
  const Schema = z.object({ n: z.number(), tags: z.array(z.string()).default([]) });
  const fallback = { n: 0, tags: [] };

  test("parses and fills defaults", () => {
    expect(readJson('{"n":2}', Schema, fallback)).toEqual({ n: 2, tags: [] });
  });

  test("missing, malformed or mismatched values give the fallback", () => {
    expect(readJson(undefined, Schema, fallback)).toBe(fallback);
    expect(readJson("", Schema, fallback)).toBe(fallback);
    expect(readJson("{n:", Schema, fallback)).toBe(fallback);
    expect(readJson('{"n":"2"}', Schema, fallback)).toBe(fallback);
  });

  test("older sync state values still load", () => {
    // Written before completeBoards and boardProjects existed.
    expect(
      parseSprintState('{"sprints":[{"id":1,"name":"S1","state":"closed","boardId":7}]}'),
    ).toEqual({
      sprints: [{ id: 1, name: "S1", state: "closed", boardId: 7, start: null, end: null }],
      completeBoards: [],
      boardProjects: {},
    });
    expect(
      parseProjectMeta('{"PAY":{"issueTypes":["Story"],"statuses":["Done"],"at":"x"}}'),
    ).toEqual({
      PAY: { issueTypes: ["Story"], statuses: ["Done"] },
    });
  });
});

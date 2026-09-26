import { expect, test } from "bun:test";
import { type ReportFacts, validateReport } from "./report";

const facts: ReportFacts = {
  periodLabel: "Since yesterday",
  since: "2026-09-25T00:00:00.000Z",
  today: "2026-09-26",
  outputLanguage: "English",
  sprint: null,
  stats: { done: 1, pointsDone: 0, inProgress: 0, new: 0, comments: 0 },
  tickets: [
    {
      key: "PAY-3",
      summary: "Refunds",
      status: "Done",
      points: null,
      group: "done",
      notes: [],
      quote: null,
    },
    {
      key: "PAY-2",
      summary: "Ledger",
      status: "Blocked",
      points: null,
      group: "blocked",
      notes: ["Blocked by OPS-7"],
      quote: null,
    },
  ],
};
const out = {
  summary: "",
  done: "- PAY-3 done",
  inProgress: "",
  changes: "",
  blockers: "- PAY-2 waits on OPS-7",
  next: "",
};

test("finished and blocked tickets must be named; keys from the facts only", () => {
  expect(validateReport(out, facts)).toEqual([]);
  expect(validateReport({ ...out, done: "" }, facts)).toEqual([
    "Mention each of these by key: PAY-3.",
  ]);
  expect(validateReport({ ...out, next: "- PAY-99 next" }, facts)).toEqual([
    "Only use ticket keys from the facts; remove PAY-99.",
  ]);
});

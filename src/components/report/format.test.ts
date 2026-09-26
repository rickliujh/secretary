import { describe, expect, test } from "bun:test";
import { dateRange, markdownToText, ReportForm, statLabels } from "./format";

describe("report as plain text", () => {
  test("has headings as lines, bullets as dots and no Markdown syntax", () => {
    const md = [
      "# Update: Since Friday",
      "Shipped the **login** fix; the import is in review.",
      "## Done\n\n- ABC-1 Login fix\n- ABC-2 *Docs* update",
      "## Next\n\n1. ABC-4 Export\n2. ABC-5 `Cleanup`",
    ].join("\n\n");
    expect(markdownToText(md)).toBe(
      [
        "Update: Since Friday",
        "",
        "Shipped the login fix; the import is in review.",
        "",
        "Done",
        "• ABC-1 Login fix",
        "• ABC-2 Docs update",
        "",
        "Next",
        "1. ABC-4 Export",
        "2. ABC-5 Cleanup",
      ].join("\n"),
    );
  });

  test("keeps a list written right under a line tight, and blank lines where the source has them", () => {
    expect(
      markdownToText("**ABC-1 Login** · DONE\n- moved to Done\n\n**ABC-2 Docs**\n- next"),
    ).toBe("ABC-1 Login · DONE\n• moved to Done\n\nABC-2 Docs\n• next");
  });

  test("indents nested lists and keeps a link's address", () => {
    expect(markdownToText("* one\n  * two\n* [spec](https://x.test/s) and <https://y.test>")).toBe(
      "• one\n  • two\n• spec (https://x.test/s) and https://y.test",
    );
  });

  test("keeps line breaks inside a paragraph", () => {
    expect(markdownToText("a  \nb")).toBe("a\nb");
  });
});

describe("report form", () => {
  test("maps the period choice and scope to a request", () => {
    expect(
      ReportForm.parse({ period: "workday", days: "", tracked: false, sprintOnly: true }),
    ).toEqual({
      period: { kind: "workday" },
      scope: "mine",
      sprintOnly: true,
    });
    expect(
      ReportForm.parse({ period: "7", days: "abc", tracked: true, sprintOnly: false }),
    ).toEqual({
      period: { kind: "days", days: 7 },
      scope: "mine_and_tracked",
      sprintOnly: false,
    });
    expect(
      ReportForm.parse({ period: "custom", days: "10", tracked: false, sprintOnly: true }).period,
    ).toEqual({
      kind: "days",
      days: 10,
    });
  });

  test("rejects custom days outside 1 to 30 or not whole", () => {
    for (const days of ["", "0", "31", "2.5", "x"]) {
      const r = ReportForm.safeParse({ period: "custom", days, tracked: false, sprintOnly: true });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["days"]);
    }
  });
});

describe("display helpers", () => {
  test("shows one date when the period starts and ends on the same day", () => {
    expect(dateRange("2026-09-26T00:00:00", "2026-09-26T15:00:00")).not.toContain("→");
    expect(dateRange("2026-09-25T00:00:00", "2026-09-26T15:00:00")).toContain("→");
  });

  test("adds points to the done badge only when there are some", () => {
    expect(statLabels({ done: 2, pointsDone: 0, inProgress: 1, new: 3, comments: 1 })).toEqual([
      "2 done",
      "1 in progress",
      "3 new",
      "1 comment",
    ]);
    expect(statLabels({ done: 2, pointsDone: 5, inProgress: 0, new: 0, comments: 4 })[0]).toBe(
      "2 done · 5 points",
    );
  });
});

import { expect, test } from "bun:test";
import { backupsToPrune } from "./backups";

test("keeps the three newest import backups and ignores other files", () => {
  expect(
    backupsToPrune([
      "backup-before-import-2026-01-01T10-00-00.json",
      "settings.json",
      "backup-before-import-2026-03-01T10-00-00.json",
      "backup-before-import-2026-02-01T10-00-00.json",
      "backup-before-import-2026-04-01T10-00-00.json",
      "backup-before-import-2025-12-01T10-00-00.json",
    ]),
  ).toEqual([
    "backup-before-import-2026-01-01T10-00-00.json",
    "backup-before-import-2025-12-01T10-00-00.json",
  ]);
});

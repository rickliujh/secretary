-- Full-text index over context notes (design.md section 4), same pattern as jira_issues_fts.
CREATE VIRTUAL TABLE `context_notes_fts` USING fts5(
  `title`,
  `body_md`,
  content='context_notes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `context_notes_fts_ai` AFTER INSERT ON `context_notes` BEGIN
  INSERT INTO `context_notes_fts`(rowid, `title`, `body_md`) VALUES (new.rowid, new.`title`, new.`body_md`);
END;
--> statement-breakpoint
CREATE TRIGGER `context_notes_fts_ad` AFTER DELETE ON `context_notes` BEGIN
  INSERT INTO `context_notes_fts`(`context_notes_fts`, rowid, `title`, `body_md`)
  VALUES ('delete', old.rowid, old.`title`, old.`body_md`);
END;
--> statement-breakpoint
CREATE TRIGGER `context_notes_fts_au` AFTER UPDATE OF `title`, `body_md` ON `context_notes` BEGIN
  INSERT INTO `context_notes_fts`(`context_notes_fts`, rowid, `title`, `body_md`)
  VALUES ('delete', old.rowid, old.`title`, old.`body_md`);
  INSERT INTO `context_notes_fts`(rowid, `title`, `body_md`) VALUES (new.rowid, new.`title`, new.`body_md`);
END;

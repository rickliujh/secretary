-- Full-text index over data source documents (D41), same pattern as jira_issues_fts.
CREATE VIRTUAL TABLE `source_documents_fts` USING fts5(
  `title`,
  `aliases`,
  `tags`,
  `body`,
  `path`,
  content='source_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `source_documents_fts_ai` AFTER INSERT ON `source_documents` BEGIN
  INSERT INTO `source_documents_fts`(rowid, `title`, `aliases`, `tags`, `body`, `path`)
  VALUES (new.rowid, new.`title`, new.`aliases`, new.`tags`, new.`body`, new.`path`);
END;
--> statement-breakpoint
CREATE TRIGGER `source_documents_fts_ad` AFTER DELETE ON `source_documents` BEGIN
  INSERT INTO `source_documents_fts`(`source_documents_fts`, rowid, `title`, `aliases`, `tags`, `body`, `path`)
  VALUES ('delete', old.rowid, old.`title`, old.`aliases`, old.`tags`, old.`body`, old.`path`);
END;
--> statement-breakpoint
CREATE TRIGGER `source_documents_fts_au` AFTER UPDATE OF `title`, `aliases`, `tags`, `body`, `path` ON `source_documents` BEGIN
  INSERT INTO `source_documents_fts`(`source_documents_fts`, rowid, `title`, `aliases`, `tags`, `body`, `path`)
  VALUES ('delete', old.rowid, old.`title`, old.`aliases`, old.`tags`, old.`body`, old.`path`);
  INSERT INTO `source_documents_fts`(rowid, `title`, `aliases`, `tags`, `body`, `path`)
  VALUES (new.rowid, new.`title`, new.`aliases`, new.`tags`, new.`body`, new.`path`);
END;

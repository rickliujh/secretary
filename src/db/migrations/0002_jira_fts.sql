-- Full-text index over cached issues (design.md section 4). External content:
-- the index stores tokens only and reads text back from jira_issues by rowid.
CREATE VIRTUAL TABLE `jira_issues_fts` USING fts5(
  `key`,
  `summary`,
  `description`,
  content='jira_issues',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `jira_issues_fts_ai` AFTER INSERT ON `jira_issues` BEGIN
  INSERT INTO `jira_issues_fts`(rowid, `key`, `summary`, `description`)
  VALUES (new.rowid, new.`key`, new.`summary`, new.`description`);
END;
--> statement-breakpoint
CREATE TRIGGER `jira_issues_fts_ad` AFTER DELETE ON `jira_issues` BEGIN
  INSERT INTO `jira_issues_fts`(`jira_issues_fts`, rowid, `key`, `summary`, `description`)
  VALUES ('delete', old.rowid, old.`key`, old.`summary`, old.`description`);
END;
--> statement-breakpoint
CREATE TRIGGER `jira_issues_fts_au` AFTER UPDATE OF `key`, `summary`, `description` ON `jira_issues` BEGIN
  INSERT INTO `jira_issues_fts`(`jira_issues_fts`, rowid, `key`, `summary`, `description`)
  VALUES ('delete', old.rowid, old.`key`, old.`summary`, old.`description`);
  INSERT INTO `jira_issues_fts`(rowid, `key`, `summary`, `description`)
  VALUES (new.rowid, new.`key`, new.`summary`, new.`description`);
END;
--> statement-breakpoint
INSERT INTO `jira_issues_fts`(`jira_issues_fts`) VALUES ('rebuild');

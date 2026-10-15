CREATE TABLE `deleted_issues` (
	`issue_key` text PRIMARY KEY NOT NULL,
	`issue_id` text,
	`deleted_at` text NOT NULL,
	`proposal_id` text
);
--> statement-breakpoint
ALTER TABLE `issue_meta` ADD `revoked_at` text;--> statement-breakpoint
-- Tickets revoked before this migration (FR-14.6): a revoked create whose record
-- says the ticket was deleted (or, in records from before `ticket` was kept, whose
-- message says so) gets its tombstone, and leaves the cache if it came back.
INSERT OR IGNORE INTO `deleted_issues` (`issue_key`, `deleted_at`, `proposal_id`)
SELECT json_extract(`result`, '$.issueKey'),
  COALESCE(json_extract(`result`, '$.revoked.at'), `decided_at`, `created_at`), `id`
FROM `proposals`
WHERE `kind` = 'create_issue' AND `status` = 'revoked'
  AND json_extract(`result`, '$.issueKey') IS NOT NULL
  AND (
    json_extract(`result`, '$.revoked.ticket.state') = 'deleted'
    OR (
      json_extract(`result`, '$.revoked.ticket') IS NULL
      AND (
        instr('; ' || json_extract(`result`, '$.revoked.message') || '; ',
          '; Deleted ' || json_extract(`result`, '$.issueKey') || '; ') > 0
        OR json_extract(`result`, '$.revoked.message') = json_extract(`result`, '$.issueKey') || ' is already deleted.'
      )
    )
  );
--> statement-breakpoint
DELETE FROM `jira_comments` WHERE `issue_key` IN (SELECT `issue_key` FROM `deleted_issues`);
--> statement-breakpoint
DELETE FROM `issue_meta` WHERE `issue_key` IN (SELECT `issue_key` FROM `deleted_issues`);
--> statement-breakpoint
DELETE FROM `jira_issues` WHERE `key` IN (SELECT `issue_key` FROM `deleted_issues`);
--> statement-breakpoint
-- The other revoked creates were closed by their revoke.
INSERT INTO `issue_meta` (`issue_key`, `revoked_at`)
SELECT json_extract(`result`, '$.issueKey'),
  COALESCE(json_extract(`result`, '$.revoked.at'), `decided_at`, `created_at`)
FROM `proposals`
WHERE `kind` = 'create_issue' AND `status` = 'revoked'
  AND json_extract(`result`, '$.revoked') IS NOT NULL
  AND json_extract(`result`, '$.issueKey') IS NOT NULL
  AND json_extract(`result`, '$.issueKey') NOT IN (SELECT `issue_key` FROM `deleted_issues`)
ON CONFLICT(`issue_key`) DO UPDATE SET `revoked_at` = excluded.`revoked_at`;

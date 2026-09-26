ALTER TABLE `jira_comments` ADD `author_display` text;--> statement-breakpoint
ALTER TABLE `jira_comments` ADD `body_html` text;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD `is_subtask` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD `description_html` text;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD `assignee_display` text;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD `reporter_display` text;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD `epic_name` text;
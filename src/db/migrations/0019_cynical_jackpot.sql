CREATE TABLE `bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`record` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bundles_inbox_idx` ON `bundles` (`inbox_item_id`);--> statement-breakpoint
ALTER TABLE `dependencies` ADD `data` text;--> statement-breakpoint
ALTER TABLE `people` ADD `jira_projects` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `jira_projects` text DEFAULT '[]' NOT NULL;
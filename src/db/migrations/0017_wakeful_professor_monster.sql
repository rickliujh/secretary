CREATE TABLE `work_events` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`issue_key` text,
	`ref` text,
	`summary` text NOT NULL,
	`data` text,
	`attached_by` text,
	`applied` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `work_events_item_idx` ON `work_events` (`work_item_id`,`at`);--> statement-breakpoint
CREATE INDEX `work_events_pending_idx` ON `work_events` (`attached_by`,`applied`);--> statement-breakpoint
CREATE INDEX `work_events_issue_idx` ON `work_events` (`issue_key`);--> statement-breakpoint
CREATE TABLE `work_item_issues` (
	`issue_key` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`role` text DEFAULT 'primary' NOT NULL,
	`added_by` text DEFAULT 'code' NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_item_issues_item_idx` ON `work_item_issues` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_by` text DEFAULT 'code' NOT NULL,
	`goal` text,
	`status` text DEFAULT 'active' NOT NULL,
	`state` text,
	`state_version` integer DEFAULT 0 NOT NULL,
	`state_updated_at` text,
	`note` text,
	`note_edited_at` text,
	`note_facts` text,
	`needs_look` integer DEFAULT false NOT NULL,
	`current` integer DEFAULT false NOT NULL,
	`merged_into` text,
	`created_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `work_items_status_idx` ON `work_items` (`status`);--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `work_item_id` text;--> statement-breakpoint
CREATE INDEX `inbox_items_work_idx` ON `inbox_items` (`work_item_id`);
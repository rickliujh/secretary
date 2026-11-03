CREATE TABLE `daily_note_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`hash` text NOT NULL,
	`text` text NOT NULL,
	`section` text,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`inbox_item_id` text,
	`work_item_id` text,
	`seen_at` text NOT NULL,
	`handled_at` text,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_note_blocks_date_hash_idx` ON `daily_note_blocks` (`date`,`hash`);--> statement-breakpoint
CREATE TABLE `daily_notes` (
	`date` text PRIMARY KEY NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	`base` text,
	`synced_at` text,
	`vault_source_id` text
);

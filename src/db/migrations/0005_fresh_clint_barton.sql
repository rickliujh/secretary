CREATE TABLE `intake_items` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_item_id` text NOT NULL,
	`idx` integer NOT NULL,
	`quote` text NOT NULL,
	`summary` text,
	`snapshot` text NOT NULL,
	`output` text,
	`prompt_version` integer NOT NULL,
	`tier` text,
	`model` text,
	`escalated` integer DEFAULT false NOT NULL,
	`low_confidence` integer DEFAULT false NOT NULL,
	`error` text,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intake_items_inbox_idx` ON `intake_items` (`inbox_item_id`);--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `proposals` ADD `intake_item_id` text REFERENCES intake_items(id);--> statement-breakpoint
ALTER TABLE `proposals` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `evidence` text;
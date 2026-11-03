ALTER TABLE `communications` ADD `quote_md` text;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `situation_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_situation_idx` ON `inbox_items` (`situation_key`) WHERE "inbox_items"."situation_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `bundle_id` text;--> statement-breakpoint
ALTER TABLE `proposals` ADD `bundle_kind` text;
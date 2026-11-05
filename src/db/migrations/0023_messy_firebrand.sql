ALTER TABLE `image_reads` ADD `error` text;--> statement-breakpoint
ALTER TABLE `image_reads` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `image_reads` ADD `last_tried_at` text;
CREATE TABLE `inbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_item_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_messages_thread_idx` ON `inbox_messages` (`inbox_item_id`,`seq`);--> statement-breakpoint
ALTER TABLE `proposals` ADD `message_id` text REFERENCES inbox_messages(id) ON DELETE set null;--> statement-breakpoint
-- Existing inbox items become one-turn threads: the input, then the triage turn.
INSERT INTO `inbox_messages` (`id`, `inbox_item_id`, `seq`, `role`, `content`, `created_at`)
SELECT 'u0-' || `id`, `id`, 0, 'user',
  json_object('parts', json_array(json_object('type', 'pasted', 'text', `raw_text`))),
  `received_at`
FROM `inbox_items`;--> statement-breakpoint
INSERT INTO `inbox_messages` (`id`, `inbox_item_id`, `seq`, `role`, `content`, `created_at`)
SELECT 'a1-' || `id`, `id`, 1, 'assistant', json_object('summary', `summary`), `received_at`
FROM `inbox_items` WHERE `status` != 'new';--> statement-breakpoint
UPDATE `proposals` SET `message_id` = 'a1-' || `inbox_item_id`
WHERE `inbox_item_id` IN (SELECT `inbox_item_id` FROM `inbox_messages` WHERE `role` = 'assistant');

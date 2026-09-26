ALTER TABLE `communications` ADD `notes_md` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `variants` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `instructions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `communications` ADD `language` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `generated_at` text;--> statement-breakpoint
-- Requests saved before drafting existed kept their notes in body_md (D24).
UPDATE `communications` SET `notes_md` = `body_md`, `body_md` = '' WHERE `status` = 'draft';

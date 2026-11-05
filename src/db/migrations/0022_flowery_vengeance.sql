CREATE TABLE `image_reads` (
	`hash` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`description` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`model` text NOT NULL,
	`created_at` text NOT NULL
);

CREATE TABLE `source_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`frontmatter` text,
	`body` text NOT NULL,
	`mtime` integer NOT NULL,
	`size` integer NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_documents_source_idx` ON `source_documents` (`source_id`);
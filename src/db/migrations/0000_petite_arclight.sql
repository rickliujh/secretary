CREATE TABLE `actions_log` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text,
	`action` text NOT NULL,
	`target` text,
	`request` text,
	`response` text,
	`ok` integer NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `actions_log_at_idx` ON `actions_log` (`at`);--> statement-breakpoint
CREATE TABLE `communications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`intent` text NOT NULL,
	`recipient_person_id` text,
	`recipient_team_id` text,
	`issue_keys` text DEFAULT '[]' NOT NULL,
	`dependency_id` text,
	`subject` text,
	`body_md` text NOT NULL,
	`variant` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`recipient_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`dependency_id`) REFERENCES `dependencies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `communications_person_idx` ON `communications` (`recipient_person_id`);--> statement-breakpoint
CREATE TABLE `context_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`source_url` text,
	`source_version` integer,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_notes_subject_idx` ON `context_notes` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_key` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`owner_person_id` text,
	`owner_team_id` text,
	`external_ref` text,
	`external_url` text,
	`status` text DEFAULT 'open' NOT NULL,
	`requested_at` text,
	`expected_at` text,
	`next_followup_at` text,
	`resolved_at` text,
	`notes_md` text,
	`mirror_remote_link_id` text,
	FOREIGN KEY (`owner_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `dependencies_issue_idx` ON `dependencies` (`issue_key`);--> statement-breakpoint
CREATE INDEX `dependencies_status_idx` ON `dependencies` (`status`);--> statement-breakpoint
CREATE TABLE `followups` (
	`id` text PRIMARY KEY NOT NULL,
	`dependency_id` text NOT NULL,
	`at` text NOT NULL,
	`channel` text,
	`summary` text,
	`communication_id` text,
	FOREIGN KEY (`dependency_id`) REFERENCES `dependencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`communication_id`) REFERENCES `communications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `followups_dependency_idx` ON `followups` (`dependency_id`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`sender_person_id` text,
	`raw_text` text NOT NULL,
	`received_at` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`triage` text,
	FOREIGN KEY (`sender_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inbox_items_received_idx` ON `inbox_items` (`received_at`);--> statement-breakpoint
CREATE TABLE `issue_meta` (
	`issue_key` text PRIMARY KEY NOT NULL,
	`priority_override` real,
	`pinned` integer DEFAULT false NOT NULL,
	`snoozed_until` text,
	`last_viewed_at` text,
	`health` text
);
--> statement-breakpoint
CREATE TABLE `issue_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_key` text NOT NULL,
	`body_md` text NOT NULL,
	`source_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_notes_issue_idx` ON `issue_notes` (`issue_key`);--> statement-breakpoint
CREATE TABLE `jira_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_key` text NOT NULL,
	`author` text,
	`body` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jira_comments_issue_idx` ON `jira_comments` (`issue_key`);--> statement-breakpoint
CREATE TABLE `jira_issues` (
	`key` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`project_key` text NOT NULL,
	`issue_type` text NOT NULL,
	`summary` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`status_category` text NOT NULL,
	`priority` text,
	`assignee` text,
	`reporter` text,
	`parent_key` text,
	`epic_key` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`components` text DEFAULT '[]' NOT NULL,
	`sprint` text,
	`due_date` text,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`resolved` text,
	`raw` text,
	`synced_at` text NOT NULL,
	`is_tracked_epic` integer DEFAULT false NOT NULL,
	`stale` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jira_issues_project_idx` ON `jira_issues` (`project_key`);--> statement-breakpoint
CREATE INDEX `jira_issues_parent_idx` ON `jira_issues` (`parent_key`);--> statement-breakpoint
CREATE INDEX `jira_issues_epic_idx` ON `jira_issues` (`epic_key`);--> statement-breakpoint
CREATE INDEX `jira_issues_updated_idx` ON `jira_issues` (`updated`);--> statement-breakpoint
CREATE INDEX `jira_issues_assignee_idx` ON `jira_issues` (`assignee`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`tier` text,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`escalated` integer DEFAULT false NOT NULL,
	`repair` integer DEFAULT false NOT NULL,
	`validation_ok` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error_kind` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_calls_at_idx` ON `llm_calls` (`at`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`content` text NOT NULL,
	`example_input` text,
	`example_before` text,
	`example_after` text,
	`source` text NOT NULL,
	`source_inbox_item_id` text,
	`confirmed` integer DEFAULT false NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_kind_idx` ON `memories` (`kind`);--> statement-breakpoint
CREATE INDEX `memories_subject_idx` ON `memories` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`jira_username` text,
	`email` text,
	`title` text,
	`team_id` text,
	`responsibilities` text,
	`profile` text DEFAULT '{}' NOT NULL,
	`notes_md` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `people_team_idx` ON `people` (`team_id`);--> statement-breakpoint
CREATE INDEX `people_jira_username_idx` ON `people` (`jira_username`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_item_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`rationale` text,
	`confidence` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`edited_payload` text,
	`result` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_inbox_idx` ON `proposals` (`inbox_item_id`);--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`function` text,
	`contact_for` text,
	`channel` text,
	`escalation_path` text,
	`confluence_urls` text DEFAULT '[]' NOT NULL,
	`notes_md` text
);

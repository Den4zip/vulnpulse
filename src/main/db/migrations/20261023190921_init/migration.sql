CREATE TABLE `feeds` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL UNIQUE,
	`source` text NOT NULL,
	`etag` text,
	`last_started_at` text,
	`last_finished_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`vulnerability_id` integer NOT NULL,
	`stack_id` integer NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_matches_vulnerability_id_vulnerabilities_id_fk` FOREIGN KEY (`vulnerability_id`) REFERENCES `vulnerabilities`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_matches_stack_id_stack_id_fk` FOREIGN KEY (`stack_id`) REFERENCES `stack`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`vulnerability_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_notes_vulnerability_id_vulnerabilities_id_fk` FOREIGN KEY (`vulnerability_id`) REFERENCES `vulnerabilities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sla` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`vulnerability_id` integer NOT NULL UNIQUE,
	`due_at` text NOT NULL,
	`patched_at` text,
	CONSTRAINT `fk_sla_vulnerability_id_vulnerabilities_id_fk` FOREIGN KEY (`vulnerability_id`) REFERENCES `vulnerabilities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `stack` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`vendor` text,
	`product` text NOT NULL,
	`version` text,
	`cpe23` text,
	`purl` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "stack_kind_check" CHECK("kind" IN ('application', 'system', 'package'))
);
--> statement-breakpoint
CREATE TABLE `vulnerabilities` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`ext_id` text NOT NULL UNIQUE,
	`feed_id` integer NOT NULL,
	`title` text,
	`description` text,
	`severity` text,
	`cvss_score` real,
	`cvss_vector` text,
	`status` text DEFAULT 'New' NOT NULL,
	`is_known_exploited` integer DEFAULT false NOT NULL,
	`published_at` text,
	`modified_at` text,
	`raw_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_vulnerabilities_feed_id_feeds_id_fk` FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON DELETE CASCADE,
	CONSTRAINT "severity_check" CHECK("severity" IS NULL OR "severity" IN ('Critical', 'High', 'Medium', 'Low', 'None')),
	CONSTRAINT "status_check" CHECK("status" IN ('New', 'Analyzing', 'Affected', 'In Progress', 'Patched', 'False Positive'))
);
--> statement-breakpoint
CREATE TABLE `vulnerability_cpes` (
	`vulnerability_id` integer NOT NULL,
	`cpe23` text NOT NULL,
	CONSTRAINT `vulnerability_cpes_pk` PRIMARY KEY(`vulnerability_id`, `cpe23`),
	CONSTRAINT `fk_vulnerability_cpes_vulnerability_id_vulnerabilities_id_fk` FOREIGN KEY (`vulnerability_id`) REFERENCES `vulnerabilities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_matches_vulnerability_stack` ON `matches` (`vulnerability_id`,`stack_id`);--> statement-breakpoint
CREATE INDEX `idx_matches_stack_id` ON `matches` (`stack_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stack_vendor_product_version` ON `stack` (`vendor`,`product`,`version`);--> statement-breakpoint
CREATE INDEX `idx_stack_cpe23` ON `stack` (`cpe23`);--> statement-breakpoint
CREATE INDEX `idx_stack_purl` ON `stack` (`purl`);--> statement-breakpoint
CREATE INDEX `idx_vulnerabilities_severity` ON `vulnerabilities` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_vulnerabilities_status` ON `vulnerabilities` (`status`);--> statement-breakpoint
CREATE INDEX `idx_vulnerabilities_feed_id` ON `vulnerabilities` (`feed_id`);--> statement-breakpoint
CREATE INDEX `idx_vulnerability_cpes_cpe23` ON `vulnerability_cpes` (`cpe23`);
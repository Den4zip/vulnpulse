CREATE TABLE `source_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`feed_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`raw_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_source_records_feed_id_feeds_id_fk` FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `vulnerability_sources` (
	`vulnerability_id` integer NOT NULL,
	`source_record_id` integer NOT NULL,
	CONSTRAINT `vulnerability_sources_pk` PRIMARY KEY(`vulnerability_id`, `source_record_id`),
	CONSTRAINT `fk_vulnerability_sources_vulnerability_id_vulnerabilities_id_fk` FOREIGN KEY (`vulnerability_id`) REFERENCES `vulnerabilities`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vulnerability_sources_source_record_id_source_records_id_fk` FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_source_records_feed_source` ON `source_records` (`feed_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_vulnerability_sources_source` ON `vulnerability_sources` (`source_record_id`);
--> statement-breakpoint
-- Data backfill for databases created before source records existed.
INSERT INTO `source_records` (`feed_id`, `source_id`, `raw_json`, `created_at`)
SELECT `feed_id`, `ext_id`, `raw_json`, `created_at` FROM `vulnerabilities`;
--> statement-breakpoint
INSERT INTO `vulnerability_sources` (`vulnerability_id`, `source_record_id`)
SELECT v.`id`, s.`id` FROM `vulnerabilities` v
JOIN `source_records` s ON s.`feed_id` = v.`feed_id` AND s.`source_id` = v.`ext_id`;

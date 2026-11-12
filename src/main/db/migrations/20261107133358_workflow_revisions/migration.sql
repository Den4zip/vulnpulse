ALTER TABLE `notes` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sla` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_notes_vulnerability_id` ON `notes` (`vulnerability_id`,`id`);
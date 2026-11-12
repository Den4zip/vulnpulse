CREATE TABLE `app_secrets` (
	`name` text PRIMARY KEY,
	`ciphertext` blob,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY,
	`revision` integer DEFAULT 1 NOT NULL,
	`value_json` text NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("id" = 1)
);

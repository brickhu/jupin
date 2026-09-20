ALTER TABLE `submissions` ADD `heartbeat_at` datetime(3);--> statement-breakpoint
ALTER TABLE `submissions` ADD `attempts` int DEFAULT 0 NOT NULL;
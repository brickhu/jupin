ALTER TABLE `articles` MODIFY COLUMN `difficulty` int NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `articles` MODIFY COLUMN `category` varchar(32) NOT NULL DEFAULT 'quote';--> statement-breakpoint
ALTER TABLE `articles` ADD `publish_date` varchar(10);--> statement-breakpoint
ALTER TABLE `users` ADD `streak_days` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `streak_best` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_read_date` varchar(10);--> statement-breakpoint
ALTER TABLE `users` ADD `freeze_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD CONSTRAINT `articles_publish_date_unique` UNIQUE(`publish_date`);
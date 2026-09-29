ALTER TABLE `articles` ADD `text` text;--> statement-breakpoint
ALTER TABLE `articles` ADD `translation` text;--> statement-breakpoint
ALTER TABLE `articles` ADD `scores` json;--> statement-breakpoint
ALTER TABLE `articles` ADD `challenge` varchar(64);--> statement-breakpoint
ALTER TABLE `articles` ADD `advice` text;--> statement-breakpoint
ALTER TABLE `articles` ADD `words` json;--> statement-breakpoint
ALTER TABLE `articles` ADD `links` json;
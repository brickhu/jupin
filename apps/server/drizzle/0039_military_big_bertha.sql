CREATE TABLE `favorites` (
	`user_id` int NOT NULL,
	`article_id` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `favorites_user_id_article_id_pk` PRIMARY KEY(`user_id`,`article_id`)
);
--> statement-breakpoint
ALTER TABLE `favorites` ADD CONSTRAINT `favorites_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `favorites` ADD CONSTRAINT `favorites_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `favorites_user_time_idx` ON `favorites` (`user_id`,`created_at`);
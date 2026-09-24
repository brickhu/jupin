ALTER TABLE `article_tags` DROP FOREIGN KEY `article_tags_article_id_articles_id_fk`;--> statement-breakpoint
ALTER TABLE `schedules` DROP FOREIGN KEY `challenges_article_id_articles_id_fk`;--> statement-breakpoint
ALTER TABLE `submissions` DROP FOREIGN KEY `submissions_article_id_articles_id_fk`;--> statement-breakpoint
ALTER TABLE `article_tags` MODIFY COLUMN `article_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` MODIFY COLUMN `article_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `submissions` MODIFY COLUMN `article_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` MODIFY COLUMN `id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `content_hash`;--> statement-breakpoint
ALTER TABLE `article_tags` ADD CONSTRAINT `article_tags_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE `schedules` ADD CONSTRAINT `challenges_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

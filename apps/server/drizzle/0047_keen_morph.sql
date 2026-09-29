ALTER TABLE `favorites` DROP FOREIGN KEY `favorites_article_id_articles_id_fk`;
--> statement-breakpoint
ALTER TABLE `participations` DROP FOREIGN KEY `participations_article_id_articles_id_fk`;
--> statement-breakpoint
ALTER TABLE `submissions` DROP FOREIGN KEY `submissions_article_id_articles_id_fk`;

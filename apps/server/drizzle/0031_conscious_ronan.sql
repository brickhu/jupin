-- ⚠️⚠️ 先把句库相关的数据清掉：这不是「顺便」，是**必须** ——
--    id 从 64 位缩到 16 位，老 id 塞不进新列（严格模式下直接报 Data too long）。
--    这次迁移的前提就是「数据不需要保留、可以清库」（用户 2026-09 确认）。
DELETE FROM `submissions`;--> statement-breakpoint
DELETE FROM `schedules`;--> statement-breakpoint
DELETE FROM `article_tags`;--> statement-breakpoint
DELETE FROM `articles`;--> statement-breakpoint
-- ⚠️ 再摘掉三张子表的外键：MySQL 不允许改一个**被外键引用**的列的长度。
--    摘 → 改 → 挂回来，是这类迁移的标准三步（迁移 0027 也是这么做的）。
ALTER TABLE `article_tags` DROP FOREIGN KEY `article_tags_article_id_articles_id_fk`;--> statement-breakpoint
ALTER TABLE `schedules` DROP FOREIGN KEY `challenges_article_id_articles_id_fk`;--> statement-breakpoint
ALTER TABLE `submissions` DROP FOREIGN KEY `submissions_article_id_articles_id_fk`;--> statement-breakpoint
ALTER TABLE `article_tags` MODIFY COLUMN `article_id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` MODIFY COLUMN `id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` MODIFY COLUMN `article_id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `submissions` MODIFY COLUMN `article_id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `article_tags` ADD CONSTRAINT `article_tags_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE `schedules` ADD CONSTRAINT `challenges_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

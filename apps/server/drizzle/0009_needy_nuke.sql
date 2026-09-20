CREATE TABLE `challenges` (
	`date` varchar(10) NOT NULL,
	`article_id` int NOT NULL,
	`source` varchar(16) NOT NULL DEFAULT 'rotation',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `challenges_date` PRIMARY KEY(`date`)
);
--> statement-breakpoint
-- ⚠️ 先解开旧的那个唯一约束：它正是「一句只能排一天」这个矛盾的来源
ALTER TABLE `articles` DROP INDEX `articles_publish_date_unique`;
--> statement-breakpoint
-- ⭐⭐ 把已经排好的日期**搬进新表** —— 这一步必须在 DROP COLUMN 之前。
-- ⚠️ 顺序反了就是一次静默的数据丢失：列没了、排期也没了，
--    而表现只是「运营明明排过，怎么全变成自动轮转了」。
INSERT IGNORE INTO `challenges` (`date`, `article_id`, `source`)
	SELECT `publish_date`, `id`, 'scheduled' FROM `articles` WHERE `publish_date` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `challenges` ADD CONSTRAINT `challenges_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `challenges_article_idx` ON `challenges` (`article_id`);
--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `publish_date`;

-- ⚠️ 先清掉引用 submissions 的三张表：id 从 40 缩到 16，老值塞不进新列；
--    本次迁移的前提是「数据不需要保留、可以清库」（用户 2026-09 确认）。
DELETE FROM `likes`;--> statement-breakpoint
DELETE FROM `reviews`;--> statement-breakpoint
DELETE FROM `submissions`;--> statement-breakpoint
-- ⚠️ 再摘掉两张子表的外键：MySQL 不允许改一个**被外键引用**的列的长度。
--    摘 → 改 → 挂回来（与迁移 0027 / 0031 同一套做法）。
ALTER TABLE `likes` DROP FOREIGN KEY `likes_submission_id_submissions_id_fk`;--> statement-breakpoint
ALTER TABLE `reviews` DROP FOREIGN KEY `reviews_submission_id_submissions_id_fk`;--> statement-breakpoint
ALTER TABLE `likes` MODIFY COLUMN `submission_id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` MODIFY COLUMN `submission_id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `submissions` MODIFY COLUMN `id` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `likes` ADD CONSTRAINT `likes_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

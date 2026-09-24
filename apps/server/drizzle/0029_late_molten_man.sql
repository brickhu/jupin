-- ⭐ 发布时间（列表要按「什么时候上的线」看，不能用 created_at 代替 ——
--    草稿可能生成很久之后才发布）。
-- ⚠️ 历史内容没有这个值：用 created_at 回填最接近 —— 本项目的既有内容都是
--    「加进仓库 → 部署灌库」上线的，那一刻就是 created_at。
-- ⚠️ 刻意不给 NOT NULL DEFAULT CURRENT_TIMESTAMP：新插入的草稿不该有发布时间。
ALTER TABLE `articles` ADD `published_at` datetime(3);--> statement-breakpoint
UPDATE `articles` SET `published_at` = `created_at` WHERE `published_at` IS NULL AND `is_active` = 1;

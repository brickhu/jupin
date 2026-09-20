ALTER TABLE `submissions` ADD `challenge_date` varchar(10);--> statement-breakpoint
CREATE INDEX `submissions_challenge_idx` ON `submissions` (`challenge_date`,`score`);
-- ⭐ 回填历史行：按**北京时间自然日**从 created_at 推出归属日期。
-- ⚠️ 必须在同一次迁移里做，否则老的提交永远不进任何一天的统计 ——
--    表现是「我明明读过，卡片上却写 0 人参与」。
-- ⚠️ +08:00 是硬编码的：MySQL 的 CONVERT_TZ 依赖时区表，
--    而云托管 MySQL 没有加载那张表（返回 NULL）。北京时间没有夏令时，
--    固定偏移是等价的，也和 packages/shared/src/day.ts 的算法一致。
UPDATE `submissions` SET `challenge_date` = DATE_FORMAT(DATE_ADD(`created_at`, INTERVAL 8 HOUR), '%Y-%m-%d') WHERE `challenge_date` IS NULL;

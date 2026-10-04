-- ⭐⭐ participations 累计成长值 + submissions 挂 participation_id（用户 2026-09 要求的两件事）
--
-- ⚠️⚠️ 四列都必须**先加（带 DEFAULT）→ 回填 → 再去掉 DEFAULT**：
--    drizzle-kit 默认生成的是 `ADD ... NOT NULL`，表里已经有行，那种写法在 strict 模式下直接失败。
-- ⚠️ 回填公式与 TS 侧必须**逐字符一致**：
--    participations.id / submissions.participation_id = LEFT(SHA2(CONCAT(user_id, ':', article_id), 256), 24)
--    （TS 实现只有一处：shared 的 participationIdOf；服务端有一条守卫盯着这段 SQL 不被改歪）
--
-- ✅ 验收判据（迁移后在本地库上对过）：
--    ① 每一行的 participation_id 都等于按公式现算的值（本地 20/20 通过）；
--    ② SUM(participations.growth_*) 等于**这一条参与下已出分 submissions 的三项之和**
--      （本地实测 self 26 = 26、standout 26 = 26，逐项相等）。
--      ⚠️ 它**不保证**等于 users.growth_*：被清掉的历史 / dev seed 直接写过的额度
--        会让 users 那边多出一点（本地 standout 就多 1）——那是"历史没了但额度还在"，
--        不是聚合算错。参与行只对**现存**的 submissions 负责。
ALTER TABLE `participations` ADD `growth_self` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `participations` ADD `growth_diligence` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `participations` ADD `growth_standout` int NOT NULL DEFAULT 0;--> statement-breakpoint
-- 回填：这条参与下**已出分** submissions 的三项之和（口径与 attempts/bestScore 一致：只算 scored）
UPDATE `participations` p
JOIN (
  SELECT `user_id`, `article_id`,
         SUM(`growth_self`) AS gs, SUM(`growth_diligence`) AS gd, SUM(`growth_standout`) AS gt
  FROM `submissions`
  WHERE `status` = 'scored'
  GROUP BY `user_id`, `article_id`
) s ON s.`user_id` = p.`user_id` AND s.`article_id` = p.`article_id`
SET p.`growth_self` = s.gs, p.`growth_diligence` = s.gd, p.`growth_standout` = s.gt;--> statement-breakpoint
ALTER TABLE `participations` ALTER COLUMN `growth_self` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `participations` ALTER COLUMN `growth_diligence` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `participations` ALTER COLUMN `growth_standout` DROP DEFAULT;--> statement-breakpoint
-- ⚠️ submissions 没有外键可挂（提交先于参与行存在），所以先给默认空串再回填，最后收紧
ALTER TABLE `submissions` ADD `participation_id` varchar(24) NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `submissions` SET `participation_id` = LEFT(SHA2(CONCAT(`user_id`, ':', `article_id`), 256), 24);--> statement-breakpoint
ALTER TABLE `submissions` ALTER COLUMN `participation_id` DROP DEFAULT;--> statement-breakpoint
CREATE INDEX `submissions_participation_idx` ON `submissions` (`participation_id`);

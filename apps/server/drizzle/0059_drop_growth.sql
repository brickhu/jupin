-- ⭐ 删掉三个成长值维度（自我超越 / 坚持不懈 / 人中翘楚）—— 规格：prd §7.6 / plan B46
--
-- 为什么删：其中「坚持不懈」与连战是同一个数、「人中翘楚」与名次是同一个数（2/3 是重复表达），
-- 而「自我超越」是相对**自己的历史最好成绩** ⇒ 平台期永远返回 0，本来就不能当累计值。
-- 它们被 0060 里的饼干取代。
--
-- 删 10 列 + 3 个索引：participations 3 列 / submissions 4 列 / users 3 列，外加 users 上 3 个索引。
--
-- ⚠️⚠️ **这条不可逆**：历史成长值没有任何地方保留（三个维度整体作废，是刻意的）。
--
-- ================================================================
-- ⚠️⚠️⚠️ **每一条都写成"存在才删"**（2026-10 补 —— dev 环境曾卡死在这条上）
-- ================================================================
--
-- 起因：dev（云托管 serverless MySQL，**自动暂停**）上 `migrate()` 抛
--   "Can't add new command when connection is in closed state" —— 连接在迁移中途断了。
--
-- ⚠️ 而 **MySQL 的 DDL 不是事务性的**（每条都隐式提交）⇒ 断在中途就是**部分执行**，
--    而 drizzle 只在**整个文件成功后**才记 created_at ⇒ 重试会**重跑整份文件** ⇒
--    已经删掉的列/索引会报 "Can't DROP ...; check that column/key exists" ⇒ **环境卡死**。
--
-- ⇒ 所以这里用 information_schema + PREPARE 做成"存在才删"
--   （MySQL 8 **没有** `DROP COLUMN IF EXISTS` / `DROP INDEX IF EXISTS`，只能这么写）。
--   ⚠️ 代价是啰嗦 —— 但比"环境永远升不上去、只能删库重建"划算得多。
--   ⚠️ 顺带定个规矩：**以后每一条删表/删列的迁移都该这么写**，理由同上。
--
-- ⚠️ 为什么空操作写 `DO 0` 而不是 `SELECT 1`：它不产生结果集，而 PREPARE 两种都支持
--    （MySQL 允许被 PREPARE 的语句列表里有 DO）。
--
-- ⚠️ 改内容**不会**让已经跑过它的库重跑：drizzle 的判据是 `__drizzle_migrations.created_at`
--    与 journal 里的 folderMillis 比大小，**不是 hash**
--    （实测见 node_modules/drizzle-orm/mysql-core/dialect.js）。
--    所以本地那份已经迁移过的库不受这次改动影响。

SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_growth_self_idx'), 'DROP INDEX `users_growth_self_idx` ON `users`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_growth_diligence_idx'), 'DROP INDEX `users_growth_diligence_idx` ON `users`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_growth_standout_idx'), 'DROP INDEX `users_growth_standout_idx` ON `users`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'participations' AND COLUMN_NAME = 'growth_self'), 'ALTER TABLE `participations` DROP COLUMN `growth_self`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'participations' AND COLUMN_NAME = 'growth_diligence'), 'ALTER TABLE `participations` DROP COLUMN `growth_diligence`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'participations' AND COLUMN_NAME = 'growth_standout'), 'ALTER TABLE `participations` DROP COLUMN `growth_standout`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submissions' AND COLUMN_NAME = 'growth_self'), 'ALTER TABLE `submissions` DROP COLUMN `growth_self`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submissions' AND COLUMN_NAME = 'growth_diligence'), 'ALTER TABLE `submissions` DROP COLUMN `growth_diligence`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submissions' AND COLUMN_NAME = 'growth_standout'), 'ALTER TABLE `submissions` DROP COLUMN `growth_standout`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submissions' AND COLUMN_NAME = 'growth_meta'), 'ALTER TABLE `submissions` DROP COLUMN `growth_meta`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'growth_self'), 'ALTER TABLE `users` DROP COLUMN `growth_self`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'growth_diligence'), 'ALTER TABLE `users` DROP COLUMN `growth_diligence`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'growth_standout'), 'ALTER TABLE `users` DROP COLUMN `growth_standout`', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;

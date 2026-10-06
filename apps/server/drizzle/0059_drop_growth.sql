-- ⭐ 删掉三个成长值维度（自我超越 / 坚持不懈 / 人中翘楚）—— 规格：prd §7.6 / plan B46
--
-- 为什么删：其中「坚持不懈」与连战是同一个数、「人中翘楚」与名次是同一个数（2/3 是重复表达），
-- 而「自我超越」是相对**自己的历史最好成绩** ⇒ 平台期永远返回 0，本来就不能当累计值。
-- 它们被下一个迁移（0060）里的饼干取代。
--
-- 删 10 列 + 3 个索引：
--   users.growth_*          总计（索引是成长榜的读路径，成长榜一起下线）
--   submissions.growth_*    本次快照（含 growth_meta 记账依据）
--   participations.growth_* 这一句累计
--
-- ⚠️⚠️ **这条不可逆**：历史成长值没有任何地方保留。
--    这是刻意的（三个维度整体作废），但要确认线上没有用户在意过这三个数。
DROP INDEX `users_growth_self_idx` ON `users`;--> statement-breakpoint
DROP INDEX `users_growth_diligence_idx` ON `users`;--> statement-breakpoint
DROP INDEX `users_growth_standout_idx` ON `users`;--> statement-breakpoint
ALTER TABLE `participations` DROP COLUMN `growth_self`;--> statement-breakpoint
ALTER TABLE `participations` DROP COLUMN `growth_diligence`;--> statement-breakpoint
ALTER TABLE `participations` DROP COLUMN `growth_standout`;--> statement-breakpoint
ALTER TABLE `submissions` DROP COLUMN `growth_self`;--> statement-breakpoint
ALTER TABLE `submissions` DROP COLUMN `growth_diligence`;--> statement-breakpoint
ALTER TABLE `submissions` DROP COLUMN `growth_standout`;--> statement-breakpoint
ALTER TABLE `submissions` DROP COLUMN `growth_meta`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `growth_self`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `growth_diligence`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `growth_standout`;
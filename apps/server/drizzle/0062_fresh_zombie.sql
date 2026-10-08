-- ⭐ 饼干账本记下 participation_id —— 让「我在这一句上攒了多少」可以直接汇总
--
-- 背景（用户 2026-10 定）：
--   原来账本只有 ref_type/ref_id（= 'submission' + submissionId），要按"这一句"汇总
--   必须 JOIN submissions 才能拿到 article_id ✗ —— 而"这一句"是产品要长期看的维度，
--   值得在账本上直接留一列。
--
-- ⚠️ 为什么记 participation 而不是 article：
--   · participation 是「一次挑战」（一句 + 局内所有人），它天然带着 article ✓
--   · 反过来（只记 article）就拿不回局信息 ✗，而"这一局我拿了多少"是要显示的
--   ⚠️ 两个维度最终都从这一列 + submissions 推得出来，不必各存一份。
--
-- ⚠️ **可空**：换能量 / 运营调整那些行**不属于任何参与**（不是"读出来的"）。
--    空就是空，**不是空串** —— 所以既不给 DEFAULT 也不 NOT NULL。
--    （与 0057/0058 那条"非空列要先给 DEFAULT 再回填再 DROP DEFAULT"是两回事：
--      那些是本来就必须有值的列。）
--
-- ⚠️⚠️ 每一条都写成"存在才做"（2026-10 的教训，见 0059 的说明）：
--    MySQL 的 DDL **不是事务性的**，断在中途就是部分执行，而 drizzle 只在整份文件成功后
--    才记 created_at ⇒ 重试会重跑整份文件 ⇒ 非幂等的写法会让环境卡死 ✗

SET @ddl = IF(NOT EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cookie_ledger' AND COLUMN_NAME = 'participation_id'), 'ALTER TABLE `cookie_ledger` ADD `participation_id` varchar(24) NULL', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
SET @ddl = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cookie_ledger' AND INDEX_NAME = 'cookie_ledger_participation_idx'), 'CREATE INDEX `cookie_ledger_participation_idx` ON `cookie_ledger` (`participation_id`)', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
-- ⚠️ 回填**历史行**：从 submissions 把 participation_id 找回来。
--    只补空的那批（幂等）—— 重跑一次不会覆盖任何东西。
UPDATE `cookie_ledger` l
  JOIN `submissions` s ON s.`id` = l.`ref_id`
  SET l.`participation_id` = s.`participation_id`
  WHERE l.`participation_id` IS NULL AND l.`ref_type` = 'submission'

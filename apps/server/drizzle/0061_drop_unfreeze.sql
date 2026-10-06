-- ⭐⭐ 解冻卡整体作废 —— 断档改成**花能量补签**（规格：prd §7.8 / plan B47）
--
-- 为什么废：道具补签要多一套「发卡 → 待领取 → 有效期 → 先到期先用」的机器，
-- 而它要做的事（补一天）在新规则里就是**花 3 点能量**。
-- 用户 2026-10 定的处置：**存量卡等比换成能量，换完直接删表，不设消费窗口**。
--
-- ## 换算（1 张 = 3 点能量）
--
--   一张卡本来就等于「补 1 天」，而新规则下补 1 天 = 3 点能量 ⇒ 1:1 等价。
--   （3 点能量 ≈ 120 饼干；⚠️ 不是"3 个饼干"—— 那是等比的 1/40。）
--
-- ## 哪些卡算数
--
--   `used_at IS NULL`（没用掉的）+ `expires_at IS NULL OR expires_at > NOW(3)`
--     · 已用掉的 → 不换（服务已经交付过了）
--     · 已过期的 → 不换（那时就已经失效了）
--   ⚠️⚠️ **待领取的（claimed_at IS NULL）也要换**：卡已经发到他名下了，
--      只是还没回连战记录页点那一下。不换等于"因为我们删了功能所以你的奖励没了"。
--
-- ## 为什么先换再删
--
--   ⚠️ 这两条 UPDATE/INSERT 必须排在 `DROP TABLE` **之前**，否则数据就没了。
--      本仓库的迁移是**顺序执行**的，所以顺序就是语义的一部分。

-- ① 未使用的卡 → 能量余额（1 张 = 3 点）
UPDATE `users` u
JOIN (
  SELECT `user_id`, COUNT(*) AS n
  FROM `unfreeze_cards`
  WHERE `used_at` IS NULL
    AND (`expires_at` IS NULL OR `expires_at` > NOW(3))
  GROUP BY `user_id`
) c ON c.`user_id` = u.`id`
SET u.`energy` = u.`energy` + 3 * c.n;--> statement-breakpoint

-- ② 补能量的流水 —— ⚠️ 能量是「流水是真相、users.energy 只是缓存」（见 schema 的说明），
--    只改余额不记流水会让对账当场对不上。
--    unique(reason, ref_type, ref_id, user_id) 保证一个用户只会有一行（重跑也安全）。
INSERT INTO `energy_ledger` (`user_id`, `delta`, `reason`, `ref_type`, `ref_id`, `created_at`)
SELECT c.`user_id`, 3 * c.n, 'card_convert', 'migration', '0061_unfreeze_to_energy', NOW(3)
FROM (
  SELECT `user_id`, COUNT(*) AS n
  FROM `unfreeze_cards`
  WHERE `used_at` IS NULL
    AND (`expires_at` IS NULL OR `expires_at` > NOW(3))
  GROUP BY `user_id`
) c
WHERE NOT EXISTS (
  SELECT 1 FROM `energy_ledger` e
  WHERE e.`user_id` = c.`user_id`
    AND e.`reason` = 'card_convert'
    AND e.`ref_type` = 'migration'
    AND e.`ref_id` = '0061_unfreeze_to_energy'
);--> statement-breakpoint

DROP TABLE `unfreeze_cards`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `unfreeze_marker_streak`;
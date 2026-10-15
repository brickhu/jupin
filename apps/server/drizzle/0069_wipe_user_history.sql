-- ⭐⭐ **一次性：清空全部用户的历史数据**（用户 2026-10-15 定：
--    「所有用户的数据都清除，所有环境都清除」＋「直接清掉，用户数据都可以清掉」）。
--
-- ⚠️⚠️ **为什么放进迁移**（而 `apps/server/scripts/wipe-history.ts` 的注释专门反对过这件事）：
--    云托管容器里**看不到日志**、也没有命令行途径——"人工跑一次性脚本"这条路在 dev/prod 上
--    实际走不通（要先在控制台开外网地址）。用户选了"折进迁移，让 AUTO_MIGRATE 自己清"。
--    ⚠️ 与脚本那条警告的差别在于**迁移只跑一次**（`__drizzle_migrations` 记着），
--      而"每次启动都清"才是灾难 —— 所以**不能**做成 `WIPE_ON_START` 那样的环境开关。
--    ⚠️ 别人的库重建时会重放这条：那时它是**空库上的空操作**（DELETE 空表），无害。
--
-- ⚠️ 范围（与本机那次手动清库**逐表一致**，由 `wipe-scope.test.ts` 机器盯着不许漂）：
--    清 —— submissions · participations · reviews · reward_grants · **cookie_ledger** · energy_ledger
--          + `users` 上那些**由提交推出来的**列（连战 / 余额 / 失格计数）
--    留 —— 账号本身（昵称头像）· favorites 收藏 · payments 支付 · subscriptions 订阅 · articles 内容
--          ⚠️ 财务与账号**不属"可以清掉的用户数据"**：清了等于没收用户的钱、也不是本次要解决的
--             "旧战绩与已确认口径对不上"那件事。
--
-- ⚠️⚠️ **删除顺序**（外键：participations / reviews → submissions；其余 → users）：
--    participations 与 reviews 必须先于 submissions。
-- ⚠️ `likes` 表已在 0066 删掉，这里不再提它。
-- ⚠️ `growth_*` 三列已随三维成长值删除，UPDATE 里不许再出现（写了就是 Unknown column ⇒ 整条回滚）。

DELETE FROM `participations`;
--> statement-breakpoint
DELETE FROM `reviews`;
--> statement-breakpoint
DELETE FROM `submissions`;
--> statement-breakpoint
DELETE FROM `reward_grants`;
--> statement-breakpoint
DELETE FROM `cookie_ledger`;
--> statement-breakpoint
DELETE FROM `energy_ledger`;
--> statement-breakpoint

UPDATE `users` SET
  `streak_days` = 0,
  `streak_best` = 0,
  `last_read_date` = NULL,
  `cookies` = 0,
  `energy` = 0,
  `energy_date` = NULL,
  `invalid_count` = 0,
  `invalid_date` = NULL;


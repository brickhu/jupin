-- ⭐⭐ 饼干（🍪）落库 —— 全站唯一的累计值（规格：prd §7.6 / plan B48）
--
-- 四样东西：
--   · cookie_ledger      流水（**真相**；幂等键 reason+ref_type+ref_id+user_id）
--   · users.cookies      可用余额（**缓存**，与流水必须同事务写）
--   · submissions.cookies_earned / cookie_meta   本次快照 + 记账依据
--   · participations.cookies                     这一句累计（派生，可整表重建）
--
-- ⚠️ 累计获得**不存列**：从流水 `SUM(delta) WHERE delta > 0` 现算。
--    它只在个人主页出现一次，多存一列就多一处会漂移的地方。
-- ⚠️ 上一条迁移（0059）已经删掉了三个成长值维度 —— 那里是**删除**，
--    这里是**新增**，刻意拆成两条：drizzle-kit 在"同表既有删除又有新增"时会
--    追问"新列是不是某个旧列改名"（交互式，CI 里没法答），拆开就没有歧义。
CREATE TABLE `cookie_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`delta` int NOT NULL,
	`reason` varchar(64) NOT NULL,
	`ref_type` varchar(16) NOT NULL,
	`ref_id` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cookie_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `cookie_ledger_idem_idx` UNIQUE(`reason`,`ref_type`,`ref_id`,`user_id`)
);
--> statement-breakpoint
-- ⚠️⚠️ 非空列**不能**照 drizzle-kit 默认的 `ADD ... NOT NULL` 写：表里已经有行，
--    那种写法在 strict 模式下**直接失败**（本仓库的规矩，见 0057 / 0058 的开头）。
--    这里走「带 DEFAULT 加 → 去掉 DEFAULT」，让最终结构与 snapshot 一致（无默认值）。
-- ⚠️ **不在这里回填**：participations 是**可整表重建的派生表**
--    （见 schema 的说明与 rebuildParticipations）——0 只是让 ALTER 能过，
--    真实值由重建补上。饼干又是一个全新的概念，本来就没有历史可回填。
ALTER TABLE `participations` ADD `cookies` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `participations` ALTER COLUMN `cookies` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `submissions` ADD `cookies_earned` int;--> statement-breakpoint
ALTER TABLE `submissions` ADD `cookie_meta` text;--> statement-breakpoint
ALTER TABLE `users` ADD `cookies` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cookie_ledger` ADD CONSTRAINT `cookie_ledger_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `cookie_ledger_user_idx` ON `cookie_ledger` (`user_id`,`created_at`);

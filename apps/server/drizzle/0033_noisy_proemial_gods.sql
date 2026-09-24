-- ⚠️⚠️ 这三列都是「同一件事的第二个来源」，一起删掉（用户 2026-09 的要求：
--    「很多事实源多个地方打架」）。逐列的判据：
--
--    ① content_status —— 与 is_active **同义的副本**。
--       注释说它们「是两回事：内容先发布、再决定开不开竞技」，但那个区分从没被实现：
--       两个写入方（后台 / 灌库）永远写同一个值，产品侧只读 is_active，
--       apps/server 的运行时一次都没读过 content_status。
--       代价却是实的：两列的 DB 默认值互相矛盾（'draft' vs true），
--       灌库路径插出来的行就是「草稿但在线」，后台按它判会拒绝一条在线的句子。
--       ⇒ 发布状态只剩 is_active 一列（见 db/schema.ts 的注释）。
--
--    ② tips_json —— 一个**没有任何写入方的声明**。技巧流水线一直没建，
--       全仓库没有一处读也没有一处写。JSON 地址又是完全可由 id 推导的形状。
--
--    ③ updated_at —— 没有 ON UPDATE 子句，且全仓库没有一处写它，
--       于是每行的 updated_at 恒等于 created_at：一列在**说谎**的时间戳。
--       它也从没被读过（publishedAt 的注释早就以此为理由说明「为什么不用它」）。
--
-- ⚠️ 三列都没有数据需要迁移：①②本来就是派生/空列，③是恒等副本。
ALTER TABLE `articles` DROP COLUMN `tips_json`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `content_status`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `updated_at`;

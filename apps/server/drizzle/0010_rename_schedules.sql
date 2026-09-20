-- ⚠️⚠️ 必须是 RENAME，不能用 drizzle-kit 默认生成的 drop + create。
--    那张表里是**排期数据**：drop 掉就是「历史那几天展示哪一句全没了」，
--    而表现只是「首页的题又变了」—— 看不出是数据被删了。
RENAME TABLE `challenges` TO `schedules`;--> statement-breakpoint
ALTER TABLE `schedules` RENAME INDEX `challenges_article_idx` TO `schedules_article_idx`;

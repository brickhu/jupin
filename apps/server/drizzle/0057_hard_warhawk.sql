-- ⭐ participations.id = 这一行的**派生地址**：sha256(`user_id` + ':' + `article_id`) 的前 24 位十六进制
--    （应用侧同一个函数见 services/participations.ts 的 participationIdOf）。
--
-- ⚠️⚠️ 分三步写，不能像 drizzle-kit 默认那样一句 `ADD id varchar(24) NOT NULL`：
--    表里已经有行，非空列必须**先回填再加约束**，否则在 strict 模式下直接失败。
-- ⚠️ 这个值**必须与 TS 侧逐字符一致**（同一个分隔符、同一个摘要、同样取前 24 位）——
--    不一致就会出现"老行一个地址、新写入另一个地址"，而且两边都不报错。
ALTER TABLE `participations` ADD `id` varchar(24);--> statement-breakpoint
UPDATE `participations` SET `id` = LEFT(SHA2(CONCAT(`user_id`, ':', `article_id`), 256), 24);--> statement-breakpoint
ALTER TABLE `participations` MODIFY `id` varchar(24) NOT NULL;--> statement-breakpoint
ALTER TABLE `participations` ADD CONSTRAINT `participations_id_idx` UNIQUE(`id`);

-- ⚠️ 把难度**收回成一个档位**（2026-09 用户纠正）：
--    词汇难度 / 发音难度是**判据**，不是字段 —— 用户看到的是一枚难度徽章 + 一句「难在哪」，
--    把两维也存成两列，「卡片上显示哪个」就没有答案了。
--
--    ⚠️ 2026-09 后续：合成规则最终定为**加权** (5×词汇 + 3×发音 + 2×长度) / 10
--       （见 packages/shared/level.ts）—— 这个迁移只做「收回成一处」，不受影响。
--    当时写的合成规则是「取更难的那一维」。反例：
--      "She sells seashells…" 词汇初级 / 发音专家 ⇒ 难度 3（专家）
--    按词汇定级会把它判成最简单的一档，那正是当初拆两轴要避免的事。
--
-- ⚠️ 重命名而不是「删掉重建」：那一列里是**已经评过级的发音档位值**，
--    虽然下一步会用新口径重判（pnpm content:regrade --apply），
--    但没必要在重判之前让线上内容变成「没有难度」。
--
-- ⚠️ vocab_level 直接删：它的值是另一条轴，无法折进 difficulty（折了就是编数据）。
--    重判会用「词汇 + 发音取更难」重新算出 difficulty。
ALTER TABLE `articles` RENAME COLUMN `pron_level` TO `difficulty`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `vocab_level`;

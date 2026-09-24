-- ⚠️⚠️ 这三列是「同一件事的第二个来源」里最典型的一组：**只写不读**的副本。
--
--    ① articles.participant_count / ② articles.conquered_count
--       —— 「这条句子有几个人参与 / 几个人攻克」。
--       竞技口径**只有一个来源**：submissions 表现算
--       （services/leaderboard.ts 的 COUNT(DISTINCT user_id)），
--       routes 里所有 participantCount 都走它。
--       两列的写入方却有两个（scoring 打分成功时自增、dev 种子脚本重算），
--       而**没有任何代码读**（seed-dev-arena 的注释自己就写着这句）。
--       更糟：scoring 里那次自增的条件读的正是下面要删的 is_conquered。
--
--    ③ submissions.is_conquered
--       —— 语义被改过两次，最后退化成 status='scored' 的同义词（写入恒为 true），
--          而**老数据是按已废除的 85 分线写的 false**。
--          全仓库其它地方早就改成按 status 判定了（submission-view / user.ts /
--          conquest.ts 都留了「不要读那一列」的注释），只剩 scoring 还在读。
--
--    ⇒ 删掉三列后，「几个人参与 / 几个人攻克」只有一个来源：submissions 表；
--      攻克的口径只有一条：status = 'scored'。
--
-- ⚠️ 没有数据需要迁移：两列计数可以随时由 submissions 重算（现在就是这么算的），
--    is_conquered 与 status 同义。
ALTER TABLE `articles` DROP COLUMN `participant_count`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `conquered_count`;--> statement-breakpoint
ALTER TABLE `submissions` DROP COLUMN `is_conquered`;

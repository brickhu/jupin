-- ⚠️ 用 CHANGE 而不是 drop + add：这一列里是**历史提交的归属日**，丢了就再也对不上。
ALTER TABLE `submissions` CHANGE `challenge_date` `schedule_date` varchar(10);--> statement-breakpoint
ALTER TABLE `submissions` RENAME INDEX `submissions_challenge_idx` TO `submissions_schedule_idx`;

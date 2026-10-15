ALTER TABLE `submissions` MODIFY COLUMN `ai_comment` varchar(200);--> statement-breakpoint
ALTER TABLE `submissions` DROP COLUMN `ai_advice`;
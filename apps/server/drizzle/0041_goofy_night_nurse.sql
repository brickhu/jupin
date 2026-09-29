ALTER TABLE `submissions` ADD `attempt_id` varchar(32);--> statement-breakpoint
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_user_attempt_idx` UNIQUE(`user_id`,`attempt_id`);
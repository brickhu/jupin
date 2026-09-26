DROP INDEX `submissions_schedule_idx` ON `submissions`;--> statement-breakpoint
CREATE INDEX `submissions_article_idx` ON `submissions` (`article_id`,`status`,`user_id`,`score`);
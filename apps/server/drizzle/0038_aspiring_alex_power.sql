CREATE TABLE `participations` (
	`user_id` int NOT NULL,
	`article_id` varchar(16) NOT NULL,
	`attempts` int NOT NULL,
	`best_score` decimal(5,1) NOT NULL,
	`worst_score` decimal(5,1) NOT NULL,
	`first_at` datetime(3) NOT NULL,
	`last_at` datetime(3) NOT NULL,
	`last_schedule_date` varchar(10),
	`best_submission_id` varchar(16) NOT NULL,
	`reached_at` datetime(3) NOT NULL,
	CONSTRAINT `participations_user_id_article_id_pk` PRIMARY KEY(`user_id`,`article_id`)
);
--> statement-breakpoint
ALTER TABLE `participations` ADD CONSTRAINT `participations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participations` ADD CONSTRAINT `participations_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participations` ADD CONSTRAINT `participations_best_submission_id_submissions_id_fk` FOREIGN KEY (`best_submission_id`) REFERENCES `submissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `participations_arena_idx` ON `participations` (`article_id`,`best_score`,`reached_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `participations_user_time_idx` ON `participations` (`user_id`,`last_at`);

--> statement-breakpoint
/*
  ⭐ 回填：把**已有的**挑战数据折成参与记录。

  ⚠️⚠️ 这一步不能省：没有它，迁移之后 participations 是空表，
     而榜单/参与场次/攻克数全部改成读它 ⇒ 线上会**静默变成全员 0**
     （不报错，只是所有人都没参与过）。

  ⚠️ 三个排序用的都是与代码完全相同的键（见 services/participations.ts）：
     · 对比标准（最高分挑战）：score DESC, created_at ASC, id ASC
     · 最近一次挑战：created_at DESC, id DESC
  ⚠️ 子查询只引用 a 的普通列（不引用聚合），MySQL 才允许 —— 所以先 GROUP BY 成派生表 a。
*/
INSERT INTO `participations`
  (`user_id`, `article_id`, `attempts`, `best_score`, `worst_score`,
   `first_at`, `last_at`, `last_schedule_date`, `best_submission_id`, `reached_at`)
SELECT
  a.user_id, a.article_id, a.attempts, a.best_score, a.worst_score, a.first_at, a.last_at,
  (SELECT s2.schedule_date FROM `submissions` s2
     WHERE s2.user_id = a.user_id AND s2.article_id = a.article_id AND s2.status = 'scored'
     ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1),
  (SELECT s3.id FROM `submissions` s3
     WHERE s3.user_id = a.user_id AND s3.article_id = a.article_id AND s3.status = 'scored'
     ORDER BY s3.score DESC, s3.created_at ASC, s3.id ASC LIMIT 1),
  (SELECT s4.created_at FROM `submissions` s4
     WHERE s4.user_id = a.user_id AND s4.article_id = a.article_id AND s4.status = 'scored'
     ORDER BY s4.score DESC, s4.created_at ASC, s4.id ASC LIMIT 1)
FROM (
  SELECT user_id, article_id, COUNT(*) AS attempts, MAX(score) AS best_score,
         MIN(score) AS worst_score, MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM `submissions` WHERE status = 'scored'
  GROUP BY user_id, article_id
) a;

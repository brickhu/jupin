CREATE TABLE `article_tags` (
	`article_id` int NOT NULL,
	`tag` varchar(32) NOT NULL,
	CONSTRAINT `article_tags_uniq_idx` UNIQUE(`article_id`,`tag`)
);
--> statement-breakpoint
CREATE TABLE `articles` (
	`id` int NOT NULL,
	`content_json` varchar(512) NOT NULL,
	`tips_json` varchar(512),
	`standard_audio` varchar(512),
	`difficulty` int NOT NULL,
	`category` varchar(32) NOT NULL,
	`content_status` varchar(16) NOT NULL DEFAULT 'draft',
	`content_hash` varchar(64),
	`is_active` boolean NOT NULL DEFAULT true,
	`participant_count` int NOT NULL DEFAULT 0,
	`conquered_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `articles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `likes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`submission_id` varchar(40) NOT NULL,
	`user_id` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `likes_id` PRIMARY KEY(`id`),
	CONSTRAINT `likes_submission_user_idx` UNIQUE(`submission_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`out_trade_no` varchar(64) NOT NULL,
	`plan` varchar(16) NOT NULL,
	`amount` int NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`prepay_id` varchar(64),
	`transaction_id` varchar(64),
	`paid_at` datetime(3),
	`refund_no` varchar(64),
	`refund_amount` int,
	`refunded_at` datetime(3),
	`raw_notify` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_out_trade_no_unique` UNIQUE(`out_trade_no`),
	CONSTRAINT `payments_transaction_idx` UNIQUE(`transaction_id`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`submission_id` varchar(40) NOT NULL,
	`content` text,
	`model` varchar(32),
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`error` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` varchar(40) NOT NULL,
	`user_id` int NOT NULL,
	`article_id` int NOT NULL,
	`seq` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`score` int,
	`is_conquered` boolean,
	`audio_key` varchar(255),
	`audio_bytes` int,
	`audio_duration_ms` int,
	`like_count` int NOT NULL DEFAULT 0,
	`word_scores` text,
	`engine` varchar(16),
	`fail_reason` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`scored_at` datetime(3),
	CONSTRAINT `submissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `submissions_user_article_seq_idx` UNIQUE(`user_id`,`article_id`,`seq`),
	CONSTRAINT `submissions_user_audio_idx` UNIQUE(`user_id`,`audio_key`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`plan` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL,
	`source` varchar(16) NOT NULL DEFAULT 'payment',
	`payment_id` int,
	`start_at` datetime(3) NOT NULL,
	`end_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openid` varchar(64) NOT NULL,
	`unionid` varchar(64),
	`nickname` varchar(64),
	`avatar_url` varchar(512),
	`status` varchar(16) NOT NULL DEFAULT 'normal',
	`member_until` datetime(3),
	`next_free_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`invalid_count` int NOT NULL DEFAULT 0,
	`invalid_date` varchar(10),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openid_unique` UNIQUE(`openid`)
);
--> statement-breakpoint
ALTER TABLE `article_tags` ADD CONSTRAINT `article_tags_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `likes` ADD CONSTRAINT `likes_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `likes` ADD CONSTRAINT `likes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `article_tags_tag_idx` ON `article_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `articles_difficulty_idx` ON `articles` (`difficulty`);--> statement-breakpoint
CREATE INDEX `articles_category_idx` ON `articles` (`category`);--> statement-breakpoint
CREATE INDEX `likes_submission_idx` ON `likes` (`submission_id`);--> statement-breakpoint
CREATE INDEX `payments_user_time_idx` ON `payments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_submission_idx` ON `reviews` (`submission_id`);--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `submissions_user_time_idx` ON `submissions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`,`end_at`);
CREATE TABLE `energy_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`delta` int NOT NULL,
	`reason` varchar(64) NOT NULL,
	`ref_type` varchar(16) NOT NULL,
	`ref_id` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `energy_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `energy_ledger_idem_idx` UNIQUE(`reason`,`ref_type`,`ref_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `reward_grants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`rule_code` varchar(64) NOT NULL,
	`ref_type` varchar(16) NOT NULL,
	`ref_id` varchar(64) NOT NULL,
	`reward_kind` varchar(16) NOT NULL,
	`reward_amount` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reward_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `reward_grants_idem_idx` UNIQUE(`rule_code`,`ref_type`,`ref_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `reward_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(64) NOT NULL,
	`trigger` varchar(32) NOT NULL,
	`params` text,
	`reward_kind` varchar(16) NOT NULL,
	`reward_amount` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`starts_at` datetime(3),
	`daily_cap` int,
	`lifetime_cap` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reward_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `reward_rules_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `unfreeze_cards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`granted_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`used_for_gap` int,
	`rule_code` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `unfreeze_cards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `submissions` ADD `growth_self` int;--> statement-breakpoint
ALTER TABLE `submissions` ADD `growth_diligence` int;--> statement-breakpoint
ALTER TABLE `submissions` ADD `growth_standout` int;--> statement-breakpoint
ALTER TABLE `submissions` ADD `growth_meta` text;--> statement-breakpoint
ALTER TABLE `submissions` ADD `energy_state` varchar(16);--> statement-breakpoint
ALTER TABLE `users` ADD `unfreeze_marker_streak` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `growth_self` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `growth_diligence` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `growth_standout` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `energy` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `energy_date` varchar(10);--> statement-breakpoint
ALTER TABLE `energy_ledger` ADD CONSTRAINT `energy_ledger_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reward_grants` ADD CONSTRAINT `reward_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unfreeze_cards` ADD CONSTRAINT `unfreeze_cards_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `energy_ledger_user_idx` ON `energy_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reward_grants_user_idx` ON `reward_grants` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `unfreeze_cards_user_idx` ON `unfreeze_cards` (`user_id`,`expires_at`);
CREATE TABLE `goods` (
	`code` varchar(32) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`amount` int NOT NULL,
	`price_fen` int NOT NULL,
	`xpay_product_id` varchar(64),
	`title` varchar(32) NOT NULL,
	`subtitle` varchar(64) NOT NULL DEFAULT '',
	`badge` varchar(16),
	`sort` int NOT NULL DEFAULT 0,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `goods_code` PRIMARY KEY(`code`)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD `goods_code` varchar(32) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `goods_kind` varchar(16) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `goods_amount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `xpay_order_id` varchar(64);--> statement-breakpoint
ALTER TABLE `payments` ADD `pay_env` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `delivered_at` datetime(3);
DROP INDEX `articles_difficulty_idx` ON `articles`;--> statement-breakpoint
DROP INDEX `articles_category_idx` ON `articles`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `difficulty`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `category`;
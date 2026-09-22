ALTER TABLE `unfreeze_cards` MODIFY COLUMN `expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `unfreeze_cards` ADD `claimed_at` datetime(3);
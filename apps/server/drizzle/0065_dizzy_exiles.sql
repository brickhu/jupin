ALTER TABLE `participations` ADD `score_parts` text;--> statement-breakpoint
ALTER TABLE `participations` ADD `audio_key` varchar(512);--> statement-breakpoint
ALTER TABLE `participations` ADD `audio_url` varchar(512);--> statement-breakpoint
ALTER TABLE `participations` ADD `audio_duration_ms` int;--> statement-breakpoint
ALTER TABLE `participations` ADD `weak_points` json;--> statement-breakpoint
ALTER TABLE `participations` ADD `ai_summary` text;--> statement-breakpoint
ALTER TABLE `participations` ADD `summary_state` varchar(16);
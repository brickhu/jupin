CREATE INDEX `users_growth_self_idx` ON `users` (`growth_self` DESC,`id`);--> statement-breakpoint
CREATE INDEX `users_growth_diligence_idx` ON `users` (`growth_diligence` DESC,`id`);--> statement-breakpoint
CREATE INDEX `users_growth_standout_idx` ON `users` (`growth_standout` DESC,`id`);
CREATE INDEX `users_created_at_idx` ON `users` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `users_energy_idx` ON `users` (`energy` DESC,`id`);
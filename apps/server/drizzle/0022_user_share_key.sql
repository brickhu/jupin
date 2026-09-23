ALTER TABLE `users` ADD `share_key` varchar(24);--> statement-breakpoint
-- ⭐ 回填存量行：分享标识是 24 位十六进制，必须随机 ——
--    ⚠️ 用 openid 拼 RAND() 再 SHA2，是为了让**每一行都不一样**；
--    ⚠️ 不能写成常量，那会让所有人的分享链接都指向同一个人。
UPDATE `users` SET `share_key` = SUBSTRING(SHA2(CONCAT(`openid`, RAND()), 256), 1, 24) WHERE `share_key` IS NULL;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_share_key_unique` UNIQUE(`share_key`);

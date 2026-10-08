-- ⭐⭐ 标准音的时长落库 —— 让 `content/` 彻底退出生产运行时
--
-- 背景（用户 2026-10）：
--   `content/` 是个**遗留目录**：句子正文在库 ✓ 标准音在对象存储 ✓ KWS 模型在
--   apps/server/assets/ ✓ —— 它早该没了 ✓
--
--   ⚠️ 而唯一还拽着它的，是阅读页顶行那个 `00:23` ✗：
--      原来 `standardAudioMs()` 读 `content/audio/<id>.mp3` **现算** ✗
--   ① 这让一个遗留目录成了**生产运行时依赖** ✗
--   ② 时长是**元数据**：**写入的那一刻就知道**（admin 上传音频时手里就有字节 ✓）
--      ⇒ 该在写的时候量一次、存起来 ✓ 而不是每次冷启动读文件解析 mp3 头 ✗
--
-- ⚠️ 可空：老内容没有这一列的值 ✓ 读不到时**退回读文件**（本机联调照常 ✓）
--    而**不是**显示成 0 ✗ —— 0 和"不知道"是两件事 ✓
--
-- ⚠️ 幂等（本仓库的硬规矩）：ADD COLUMN 重跑会报 1060 Duplicate column ✗
--    ⇒ 先查 information_schema 再决定执不执行 ✓（MySQL 8 没有 ADD COLUMN IF NOT EXISTS）
SET @ddl = IF(NOT EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'articles' AND COLUMN_NAME = 'standard_audio_ms'), 'ALTER TABLE `articles` ADD `standard_audio_ms` int', 'DO 0');--> statement-breakpoint
PREPARE s FROM @ddl;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;

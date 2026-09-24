-- ⭐ 难度**拆成两条独立的轴**（2026-09 决定）：
--    · pron_level（发音难度，原列名 difficulty 重命名而来）—— 中文母语者读出来有多难念；
--    · vocab_level（词汇难度，新增）—— 小学 / 高中 / 六级 / GRE 那套口径，含句式复杂度。
--
-- ⚠️ 为什么重命名而不是「删掉重建」：数据要留着。这两列是**派生索引**，
--    真相在正文 JSON 的 pronLevel / vocabLevel 里 —— 就算丢了也能重跑 reindex，
--    但没必要白白让线上内容在重跑之前「没难度」。
--
-- ⚠️ 两条轴**刻意不合成一个加权分**。反例各占一边：
--    "She sells seashells…" 词汇初级 / 发音专家；
--    "The only thing we have to fear … unreasoning … paralyzes …" 词汇中级 / 发音专家。
--    任何单轴公式都必然牺牲其中一个。若要按难度筛选，请按**两条轴分别筛**。
ALTER TABLE `articles` RENAME COLUMN `difficulty` TO `pron_level`;--> statement-breakpoint
ALTER TABLE `articles` ADD `vocab_level` int;

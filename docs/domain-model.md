# 数据模型 ↔ 业务概念对照（只读审计）

> **只读审计**：不改代码、不改表、不动 prd/plan/spec 正文；本文只描述**现状**（真相在哪、谁在写、哪里越界），不给改造方案、不写待办。
> 证据一律 `文件:行`。审计基线：git `0d9f3d4`（分支 `dev`）。
> 拿不准的结论标 **待核实**，并写清为什么拿不准。
>
> 口径约定：**唯一写入方** = 该概念/该表/该列在运行时只有一处代码会写它。
> 「脚本 / 迁移 / 冒烟」只要**绕过**了那个入口，就算越界，哪怕它是一次性运维动作。

---

## 一、概念 → 数据 对照表

### 总表（先看这张）

| # | 业务概念 | 真相在哪 | 唯一写入方 | 派生物 / 对账 | 主要读者 |
|---|---|---|---|---|---|
| 0 | 一个用户（账号） | `users` 一行；**凭据是 openid，身份是 `users.id`** | ⭐⭐ **唯一建行点**：`POST /api/auth/register`（用户在「加入句拼」页按下「确认加入」）→ `createUserByOpenid`（`services/user.ts`）。⚠️ 2026-09 起**注册不能自动**：`authMiddleware` 与 `/api/auth/login` **只查不建**（`findUserByOpenid`），未注册回 403 `NOT_REGISTERED`；`getOrCreateUserByOpenid` 已删除 | 无 | `/api/user/me` 及所有 `/api/user/*` |
| 1 | 金句（正文 / 难度 / 标签 / 主题 / 上线状态） | **`articles` 表上的列**（2026-09 拆列：text / translation / scores / challenge / advice / words / links / tags / difficulty / is_active，见 AGENT.md §1.5） | `services/article-content.ts`（唯一写入方，机器守着） | `tags` / `difficulty` 由 `text`+`scores` 派生并物化到列；主题是 id 的纯函数 | `/api/articles`（通用查询）、`/api/articles/latest`、`/api/article/{id}`、`/api/articles/today`、`/api/stats` + `/api/article/{id}/participations`、`/api/stats/participation` |
| 2 | 一次朗读（录音） | 对象存储里的音频；索引在 `submissions`（`audio_key` / `audio_url` / `bytes` / `duration_ms` / `is_public`） | **无** —— 3 个写点（受理 insert、评测 update、可见性 update） | 失败时对象被删；成功时归档成 mp3 并改 `audio_key` | `GET /api/challenge/:sid/audio`、`/api/user/challenges` |
| 3 | 一次评测（分数 / 逐词 / 点评） | `submissions` 的 `score` / `word_scores` / `dimensions` / `score_parts` / `ai_comment` / `ai_advice` | 唯一模块 `services/scoring.ts`；**函数级不唯一**（`runScoring` / `fail`） | `participations`（比分）；`users.growth_*`（结算） | `GET /api/user/submissions/:id`、`GET /api/challenge/:sid`、`/api/user/challenges` |
| 4 | 一次奖励结算（成长值 / 连战 / 能量） | `submissions`（快照）+ `users`（累计/连战/能量）+ `energy_ledger` + `unfreeze_cards` + `reward_grants` | 唯一入口 `services/settle.ts:47`；**但内部跨 4+ 个独立事务** | `submissions.growth_*` / `streak_delta` 是快照 | 结果页 `SubmitResponse.growth` / `.streak`、`/api/user/me` |
| 5 | 我的战绩（best / attempts / 名次） | `submissions`（聚合） | `syncParticipation`（`services/participations.ts:155`，由 `scoring.ts:299` 调） | `participations`（一人一句一行；对外地址 `id = sha256(userId:articleId)` 前 24 位 —— **派生值，整表重建后不变**，见 `services/participation-id.ts` 与迁移 0057）；重建/对账 `pnpm db:participations --apply` | `/api/user/participations`、`/api/user/participation/{articleId}`（+ 子资源 `/submissions`）、**`/api/participation/{id}`**（公开：按地址看任意一条，从榜单点进去）、首页卡片 |
| 6 | 金句榜 | 无表，直接读 `participations` | 无写入（纯查询） | 不物化；排序键三键全序 | `/api/article/{id}/participations?sort=score`、`/api/user/submissions/:id` |
| 7 | 今日挑战（24 小时窗口） | `users.today_article_id` + `today_assigned_at` | `recommendToday`（`services/recommend.ts:330`） | 无 | `GET /api/articles/today?uid=`（uid 可省略 = 匿名，走 `pickAnonymousArticle`） |
| 8 | 难度档位 | **`articles.scores`**（三个判据分才是源）；`articles.difficulty` 由它算出 | `services/article-content.ts`（写 scores 时一并算 difficulty） | `articles.difficulty`（派生列，供 SQL 筛选） | 端侧展示读 `difficulty`；SQL 筛选读同一列 |
| 9 | 收藏 | `favorites`（user_id, article_id） | `setFavorite`（`services/favorites.ts:23`） | 无 | `/api/user/favorites`、`/api/user/favorited`（我收藏了吗）、`/api/stats/favorite-count`（大家收了多少） |
| 10 | 连战 | `users.streak_days` / `streak_best` / `last_read_date` | `recordRead`（`services/streak.ts:83`）——**但被 `unfreeze.ts:183` 绕过一处** | 连战日历现算（`services/streak-record.ts`） | `/api/user/me`、`/api/user/streak-record` |
| 10b | 解冻卡 | `unfreeze_cards`（一张卡一行，有效期/领取/使用都在行上） | 发放 `grantUnfreezeCard`（`unfreeze.ts:98`）、领取 `claimUnfreezeCards`（`unfreeze.ts:75`）、使用 `useUnfreezeCards`（`unfreeze.ts:131`）——三个动作各有唯一函数 | 无 | `/api/user/me`、`/api/user/claim`、`/api/user/unfreeze` |
| 11 | 能量 | `energy_ledger`（流水=真相），`users.energy` 是缓存 | `services/energy.ts`（`topUp/hold/release/addEnergy`）——**但 `services/user.ts:53/75` 直接写缓存** | 缓存 + 流水**同事务**写；**无对账命令** | `/api/user/me`、`/api/user/energy`、提交接口 429 |
| 12 | 内容上线状态 | `articles.is_active`（唯一列） | **无** —— admin 2 处 + 灌库 1 处（见 1.1） | `articles.published_at` 记录上线时刻 | `/api/articles`、`/api/articles/latest`、推荐选句 |

### 1.1 金句 / 内容属性 / 上线状态

**① 唯一写入方？无。**

| 数据 | 写入点（`文件:行`） | 说明 |
|---|---|---|
| 句子各列 | `services/article-content.ts`（由 `/api/admin/*` 与部署灌库共用） | `articles` 表；`tools/admin` 通过 `/api/admin/*` 间接写 |
| `articles.difficulty` | `services/article-index.ts:73`（syncArticleIndex）、`tools/admin/server.ts:650,662`（upsertArticle） | **两处都直接写这一列**。schema 注释说「不要手写、只由 syncArticleIndex 物化」（`apps/server/src/db/schema.ts:32`），但 admin 发布自己又写了一次 |
| `article_tags` | `services/article-index.ts:76,78` | 这一个是真·唯一写入方 |
| `articles.is_active` | `tools/admin/server.ts:646,662`（upsertArticle）、`tools/admin/server.ts:880`（setPublishedBatch）、`apps/server/src/db/seed-articles.ts:92`（灌库插值） | **三个写入方** |
| `articles.published_at` | `tools/admin/server.ts:660,662`、`tools/admin/server.ts:880`、`apps/server/src/db/seed-articles.ts:93` | 三个写入方；灌库那处把发布时刻写成灌库时刻 |
| `articles.standard_audio` | `services/standard-audio.ts:204`、`apps/server/src/db/seed-articles.ts:125`（仅 STORAGE=local）、`tools/admin/server.ts:648,662`、`tools/rename-content-to-hash.mjs:98` | **四个写入方** |
| `articles.theme` | `tools/admin/server.ts:647,662`、`apps/server/src/db/seed-articles.ts:91`、`tools/backfill-article-theme.ts:91` | 它是 `themeFromHash(id)` 的物化副本（`packages/shared/src/theme.ts:111`） |

**② 真相在哪。** 正文的真相**就是 `articles` 表上的列**（2026-09 拆列，见 AGENT.md 1.5）：`text` / `translation` / `scores` / `challenge` / `advice` / `words` / `links` 是**源**；`difficulty` / `tags` / `theme` / `standard_audio` 是**派生**（由 `scores` / `text` / `id` 算出）；`is_active` 是**源**。⚠️ 仓库里的 `content/articles/` 下那些 json 只剩「历史内容的导入源」这一个角色，运行时不再读它。

⚠️⚠️ **`articles.text` 不可变**（用户 2026-09 定）：`articleId = sha256(text) 前 16 位` ⇒ 改正文就是另一句。
判据落在**唯一写入函数** `services/article-content.ts` 的 `saveArticleContent()`：更新分支比较正文，不一致抛 `ArticleTextImmutableError` → admin 写接口回 400。允许原地改的只有派生 / 附属列（translation / scores / tags / challenge / advice / standard_audio / is_active）。`db/seed-articles.ts` 的两处写入要么 `insert().ignore()`（已存在的行一律不动）、要么只在 `text IS NULL` 时补，不违反这条。

**③ 派生物 / 对账。**
- 难度 / 标签 → `articles.difficulty` + `article_tags`，由 `syncArticleIndex` / `reindexArticles`（`services/article-index.ts:89,109`）幂等重建。
- 命令：`pnpm content:regrade --apply`（`tools/regrade-content.ts:66` 调 `syncArticleIndex`）。
- 自洽检查在正文层：`services/content-files.test.ts:54` 验 `difficulty === difficultyFromScores(scores)`（**不查库**）。
- `is_active` / `published_at`：**没有对账命令**。

**④ 读它的地方。** `GET /api/articles`（通用查询：标签/难度筛选 + 排序）与 `GET /api/articles/latest`（最新上线，共用 `services/article-list.ts`）、`GET /api/article/{id}`、`GET /api/articles/today?uid=`（`routes/articles.ts` 的 today 路由）、`GET /api/article/{id}/participations`（**参与者/榜单**）与 `GET /api/stats/participation?ids=`（**统计**，`routes/article.ts` / `routes/stats.ts`）。⚠️ 这两条参与读路径**不校验句子存在与否**（只查 `participations`），句子下架 / 换版照样返回（旧 `/api/arenas/:articleId` 已删）。

### 1.2 一次朗读（录音）

**① 唯一写入方？无（3 个写点，都在两个模块内）。**

| 写什么 | 写点 | 说明 |
|---|---|---|
| 受理时插 `submissions`（`audio_key/audio_url/status='scoring'/energy_state='held'`） | `routes/submissions.ts:187` | 路由直接 insert |
| 评测成功时写 `audio_bytes/audio_duration_ms` | `services/scoring.ts:264-283`（与 score 同一条 UPDATE） | |
| 归档后改 `audio_key` / 清 `audio_url` | `services/scoring.ts:322-324` | 由 `archiveRecording` 成功后写 |
| 改 `is_public` | `routes/submissions.ts:297` | 路由直接 update |

**② 真相在哪。** 音频字节在对象存储；库里 `submissions` 是索引：`audio_key`（`schema.ts:443`）、`audio_url`（`:459`）、`audio_bytes`（`:461`）、`audio_duration_ms`（`:462`）、`is_public`（`:470`）。失败时对象被删、库里仍留 key 痕迹（`services/scoring.ts:422-426`）。

**③ 派生物。** 无。`is_public` 只影响「卡片之外的入口能不能听」（`schema.ts:464-470`）。

**④ 读它的地方。** `GET /api/challenge/:sid/audio`（`routes/public.ts:114`）、`GET /api/user/challenges`（`routes/user.ts:38`，含 `word_scores` 但音频另取）。

### 1.3 一次评测（分数 / 逐词 / 点评）

**① 唯一写入方？唯一模块 `services/scoring.ts`；没有单一函数。**
- `runScoring`（`scoring.ts:115`）写 `status='scored'` + `score/word_scores/dimensions/score_parts/ai_comment/ai_advice/scored_at/energy_state='charged'`（`scoring.ts:264-283`）。
- `fail`（`scoring.ts:391`）写 `status='failed'` + `fail_reason`（`scoring.ts:394-396`）。
- `claimStaleScoring`（`scoring.ts:72`）与 `startHeartbeat`（`scoring.ts:97`）只写 `heartbeat_at` / `attempts`。

**② 真相在哪。** 就在 `submissions` 那一行：`score:426`、`word_scores:485`、`dimensions:493`、`score_parts:564`、`ai_comment:552`、`ai_advice:553`、`engine:541`、`status:395`。

**③ 派生物 / 对账。** `participations`（比分）由 `syncParticipation` 在评分后更新（`scoring.ts:299`），可 `pnpm db:participations --apply` 重建。**评测列本身没有对账手段**。

**④ 读它的地方。** `GET /api/user/submissions/:id`（`routes/submissions.ts:220`，经 `describe` `services/submission-view.ts:28`）、`GET /api/challenge/:sid`（`routes/public.ts:45`）、`GET /api/user/challenges`、`GET /api/user/participation/{articleId}/submissions`。

### 1.4 一次奖励结算（成长值 / 连战 / 能量）

**① 唯一入口有，唯一事务没有。** `settle`（`services/settle.ts:47`）是全站唯一结算入口，由 `scoring.ts:362` 调用；轮询 / 重放 / 接管都不结算（`settle.ts:21`）。但它一次做了四组写、分属**不同事务**：

| 步骤 | 写点 | 事务 |
|---|---|---|
| 连战天数 | `recordRead` → `services/streak.ts:100-107`（写 `users.streak_days/streak_best/last_read_date`） | 独立 UPDATE，不在 `settle` 的事务里 |
| 成长值快照 + 累计 | `settle.ts:98-140`：`submissions.growth_*`(`:100`) 与 `users.growth_*`(`:132`) **同一事务** | ✅ 一个事务 |
| 奖励求值 | `evaluateRewards`（`services/rewards.ts:135`）→ `grantReward`（`rewards.ts:241`，自己一个事务，写 `reward_grants` + `energy_ledger`/`users.energy` 或 `unfreeze_cards`） | 每条奖励各一个事务 |
| 发卡记账位 | `rewards.ts:167` 更新 `users.unfreeze_marker_streak` | 独立 UPDATE，不在 `grantReward` 事务里 |
| 结算快照 | `settle.ts:106-112` 写 `submissions.streak_delta` | 与成长值同事务 |

**② 真相在哪。** 累计值在 `users`（`growth_*`:113-117、`streak_*`:80-91、`energy`:127、`unfreeze_marker_streak`:104）；本次明细是 `submissions` 上的**快照**（`growth_*`:516-520、`growth_meta`:526、`streak_delta`:503）。

**③ 派生物 / 对账。** 成长值三榜直接读 `users.growth_*`（`services/growth-rank.ts:34`）。**没有**任何把 `users.growth_*` 与 `submissions.growth_*` 求和比对、或把两者之一与结算记录对账的命令。

**④ 读它的地方。** `SubmitResponse.growth` / `.streak`（`services/submission-view.ts:96-119`），端侧结果页（`apps/miniprogram/src/pages/reading/reading.ts:1478`）；累计 `GET /api/user/me`（`routes/user.ts:327`）。

**⑤ 中间失败会怎样（代码事实）。** `settle` 抛错时 `runScoring` 的 `catch` 调 `fail`（`scoring.ts:376`），而 `fail` 的 WHERE 是 `status='scoring'`（`scoring.ts:396`）——此时 `status` 已是 `scored`，于是**什么也不写**。此后 `runScoring` 因 `row.status !== 'scoring'` 直接返回（`scoring.ts:120`），所以这条提交会**永久停在「status=scored 但 growth_self=NULL」**：streak 可能已加、奖励可能已发、成长值缺失。`SubmitResponse` 的注释承认存在这个窗口（`packages/shared/src/types/api.ts:190`），但全仓库没有补偿入口。

### 1.5 我的战绩（best / attempts / 名次）

**① 唯一写入方。** `syncParticipation`（`services/participations.ts:155`）是 `participations` 的唯一运行时写入方（`participations.ts:7,134,136-147`），比分后由 `scoring.ts:299` 调用。整表重建 `rebuildParticipations`（`participations.ts:207`）走同一份 `computeParticipation`（`participations.ts:60`）。
**名次不落表**，每次现算：`getRank`（`services/leaderboard.ts:133`）。

**② 真相在哪。** `submissions`；`participations` 是派生索引（`schema.ts:610-619`）。口径：**只算 status='scored'**（`participations.ts:45-51`）。

**③ 派生物 / 对账。** `participations` 可整表重建，命令 `pnpm db:participations --apply`（`apps/server/scripts/rebuild-participations.ts:22`）——带 `--check` 逐字段对账。`seed-dev-arena.ts:262` 也调同一个 `rebuildParticipations`。

**④ 第二处投影（同一真相）。** `GET /api/user/participation/{articleId}/submissions` **不读** `participations`，直接对 `submissions` 现算 best/attempts（`routes/user.ts` 的 `participationSubmissionsRoute`）。

**⑤ 读它的地方。** `GET /api/user/participations`（列表）、`GET /api/user/participation/{articleId}`（单条 + 逐次提交子资源）、`GET /api/user/me` 的 `conqueredCount`（`services/conquest.ts:17`）；端侧首页卡片（`apps/miniprogram/src/pages/index/index.ts:630`）、参与场次页、竞技场页。

### 1.6 金句榜

**① 唯一写入方。** 无写入——榜单没有表，全部从 `participations` 现查（`services/leaderboard.ts:25-31`）。

**② 真相在哪。** `participations`（`schema.ts:620-660`）。排序是**三键全序**：`best_score DESC, reached_at ASC, user_id ASC`（`leaderboard.ts:212-216`）。

**③ 派生物 / 对账。** 同 1.5（`participations` 的重建命令）。
成长值三榜是另一套：直接读 `users.growth_*`（`services/growth-rank.ts:31-38`），**不**参与 `participations` 重建。

**④ 读它的地方。** `getTopLeaderboard`（`leaderboard.ts:190`）、`getLeaderboardAround`（`:230`）、`getRank`（`:133`）、`getArenaStatsBatch`（`:324`）、`getMyBest`（`:62`）、`getBestExcluding`（`:87`）；接口 `/api/article/{id}/participations?sort=score`、`/api/user/submissions/:id`、`/api/user/participation/{articleId}`（名次/参与人数）；成长榜 `/api/leaderboards/growth`（`routes/leaderboards.ts`，**按需取**：`?self` / `?diligence` / `?standout`，都不带 = 三块全给；读 `users.growth_*` 的三个降序索引）。

### 1.7 今日挑战（24 小时窗口）

**① 唯一写入方。** `recommendToday`（`services/recommend.ts:203`）：窗口内命中就直接返回不写；否则在 `recommend.ts:330-333` 落库。窗口 = `[today_assigned_at, +24h)`（`recommend.ts:181,228-231`）；选句按**窗口起始日**天号取模（`recommend.ts:268`）。

**② 真相在哪。** `users.today_article_id` + `users.today_assigned_at`（`schema.ts:147-149`）。注释说明它必须落库、不能现算（`schema.ts:132-145`）。

**③ 派生物 / 对账。** 无。`recommend` 依赖 `participations`（`recommend.ts:285-296`）判「未读优先」；`participations` 漂移会改变推荐结果。

**④ 读它的地方。** `GET /api/articles/today?uid=<id>`（`routes/articles.ts` 的 today 路由）。
⚠️ 返回 `{ date, item }`：`item` 是**纯句子数据**（标准 ArticleCard）；`date` 是服务端的今天，**只用于端侧按天缓存**（成绩归属由服务端在受理提交时决定）。
⚠️ **uid 可省略 = 匿名**：不走窗口，改走 `pickAnonymousArticle`（`services/recommend.ts`）——
**初级档**里有正文的句子、按**参与人数加权随机**挑一条，**不写任何用户行**。
⚠️ 排期那套（`schedules` 表 + `services/schedules.ts` + `/api/schedules`）**已整体删除** ⇒ "今天读哪一句"只有这一个来源，不存在"两套口径"。
⭐ 「我今天在这句上的战绩」不在 today 里，走 `GET /api/user/participation/{articleId}`（鉴权，没参与过 data 为 null）。

### 1.8 难度档位

**① 唯一写入方？无。** 派生列 `articles.difficulty` 有两个写点：`services/article-index.ts:73`（syncArticleIndex）与 `tools/admin/server.ts:650,662`（upsertArticle，随后 `:663` 又调 syncArticleIndex 写同一值）。灌库路径 `seed-articles.ts` **不**直接写 difficulty，只调 `reindexArticles`（`seed-articles.ts:134`）。

**② 真相在哪。** **`articles.scores`**（三个判据分）才是源；难度由它算出：`difficultyFromScores` / `weightedScoreOf`（`packages/shared/src/level.ts`）。`articles.difficulty` 是「能走 SQL 筛选」的派生列。⚠️ 老注释把这件事写反过（说「真相在正文的 difficulty 里」），实现一直是从 `scores` 算 —— 2026-09 已按事实改。

**③ 派生物 / 对账。** `articles.difficulty` + `article_tags`（`article-index.ts:72-80`），幂等重建 `reindexArticles`（`:109`）。命令 `pnpm content:regrade --apply`（`tools/regrade-content.ts:11,66`）。自洽单测 `services/content-files.test.ts:54`（只验正文，不验库）。

**④ 读它的地方。** SQL 筛选：`recommend.ts`（`pickAnonymousArticle` 按 `articles.difficulty` 取初级档池子；`bandOf` 按该档取池子）。端侧展示：一律读**正文**再 `normalizeLevel`（`routes/articles.ts`、`routes/favorites.ts:86`）。

### 1.9 收藏

**① 唯一写入方。** `setFavorite`（`services/favorites.ts:23`）；路由 `PUT/DELETE /api/user/favorites/:articleId`（`routes/favorites.ts:24,38`）。主键 `(user_id, article_id)`，两个方向都幂等（`favorites.ts:29-35`）。

**② 真相在哪。** `favorites`（`schema.ts:790-799`）。句子下架不清收藏（`schema.ts:787`）。

**③ 派生物 / 对账。** 无。

**④ 读它的地方。** `listFavorites`（`favorites.ts:61`）→ `GET /api/user/favorites`（`routes/favorites.ts:53`，收藏列表页）；`favoriteIdsOf`（`favorites.ts:42`）→ `GET /api/user/favorited`（`routes/favorites.ts` 的 `favoritedRoutes`，竞技场页的按钮状态）；`favoriteCountsOf`（`favorites.ts`）→ `GET /api/stats/favorite-count?ids=`（`routes/stats.ts`，公开的收藏总量）。

### 1.10 连战与解冻卡

**连战 ① 唯一写入方（名义上）。** `recordRead`（`services/streak.ts:83`，写 `:100-107`）。规则纯函数在 `packages/shared/src/streak.ts`，服务层只做「读 → 纯函数 → 写」。
**越界：** `useUnfreezeCards` 直接改 `users.last_read_date`（`services/unfreeze.ts:183`）——补签改变了连战的输入，但没有经过 `streak.ts`。

**连战 ② 真相在哪。** `users.streak_days/streak_best/last_read_date`（`schema.ts:80-91`）。

**连战 ③ 派生物 / 对账。** 连战日历**现算**（`services/streak-record.ts`，`routes/user.ts:378`）。无对账命令。

**连战 ④ 读它的地方。** `readStreakView`（`streak.ts:48`）→ `GET /api/user/me`（`routes/user.ts:334`）；`GET /api/user/streak-record`。

**解冻卡 ① 写入方（按动作分三个唯一函数）。** 发放 `grantUnfreezeCard`（`unfreeze.ts:98`，只在 `grantReward` 事务内被调，`rewards.ts:305`）；领取 `claimUnfreezeCards`（`unfreeze.ts:75`，路由 `routes/user.ts:440`）；使用 `useUnfreezeCards`（`unfreeze.ts:131`，路由 `routes/user.ts:457`）。「手上几张」现算：`unfreezeStatus`（`unfreeze.ts:34`，三条判据 `claimed_at IS NOT NULL AND used_at IS NULL AND expires_at > now`）。
**越界：** `db/seed-dev-arena.ts:169` 直接 `DELETE` 用户的卡、`:173` 直接 `INSERT` 卡，绕过了 `grantUnfreezeCard`（因此没有对应的 `reward_grants` 幂等记录）。

**解冻卡 ② 真相在哪。** `unfreeze_cards`（`schema.ts:853-886`），一张卡一行，有效期/领取/使用都在行上（`schema.ts:863-877`）。

**解冻卡 ③ 派生物 / 对账。** 无。`unfreeze_marker_streak`（`users`:104）是「上次发卡时的天数」记账位，由 `rewards.ts:167` 推进。

**解冻卡 ④ 读它的地方。** `GET /api/user/me`（`routes/user.ts:334`）、`GET /api/user/streak-record`（`routes/user.ts:378`）、`POST /api/user/claim`（`:440`）、`POST /api/user/unfreeze`（`:457`）。

### 1.11 能量

**① 唯一写入方（名义上）。** `services/energy.ts`：`topUpEnergy`（`:58`，写缓存 `:71` + 流水 `:75`）、`holdChallengeEnergy`（`:120`，`:135`+`:136`）、`releaseChallengeEnergy`（`:157`，`:165`+`:166`）、`addEnergy`（`:183`，`:206`+`:207`）、`grantEnergy`（`:224`）。缓存与流水**同事务**（`energy.ts:14-16`）。
**越界：** `services/user.ts:53` 直接 `UPDATE users SET energy=9999`（本地联调特权），`:75` 建号时直接给 `energy`——**都不写 `energy_ledger`**。`apps/server/scripts/wipe-history.ts:114-119` raw SQL 把 `users.energy` 清零（同时清 `energy_ledger`，属于「一起清」）。

**② 真相在哪。** `energy_ledger` 是真相，`users.energy` 是缓存（`schema.ts:946-958`、`energy.ts:14`）。`energy_ledger` 的唯一键 `(reason, ref_type, ref_id, user_id)` 是一次性发放的幂等键（`schema.ts:955-957,970`）。

**③ 派生物 / 对账。** 无。**全仓库没有**把 `SUM(energy_ledger.delta)` 与 `users.energy` 比对的命令或测试（`package.json` scripts 与 `tools/` 均无）。这是「缓存 + 流水」结构下唯一缺失的对账。

**④ 读它的地方。** `readEnergy`（`energy.ts:88`，内部先 `topUp`）→ `GET /api/user/me`（`routes/user.ts:340`）、`GET /api/user/energy`（`routes/user.ts:402`）、提交 429 响应（`routes/submissions.ts:175`）。

### 1.12 内容上线状态

**① 唯一写入方？无。** `articles.is_active` 的写点：`tools/admin/server.ts:646,662`（upsertArticle，三态 `publish`）、`tools/admin/server.ts:880`（setPublishedBatch 批量）、`apps/server/src/db/seed-articles.ts:92`（灌库一律 `isActive:true` 且 `.ignore()` 不动已存在行）。`schema.ts:223-237` 明确说它是「全仓库唯一的那个真相」——**唯一的是语义，不是写入方**。

**② 真相在哪。** `articles.is_active`（`schema.ts:237`）。旧列 `content_status` 已删（迁移 0033，`schema.ts:225-235`）。

**③ 派生物 / 对账。** `articles.published_at`（`schema.ts:277`）是「最近一次上线时刻」，只在草稿→已发布那一刻写（admin `:660`、`:880`；灌库 `:93`）。无对账命令。

**④ 读它的地方。** `GET /api/articles`、`GET /api/articles/latest`、推荐选句 `bandOf`（`recommend.ts:150`）与已分配句校验（`recommend.ts:235`）、admin 列表。`GET /api/article/{id}/participations` 与 `GET /api/stats/participation` **不读**它（`routes/article.ts` / `routes/stats.ts`）—— 它们只看 `participations`，**句子行不在也照常返回**。

---

## 二、越界写入清单

判定标准：**绕过某个函数/模块声称的唯一写入方，或让同一真相出现第二个写入方**。逐条给 `文件:行` + 写什么 + 为什么危险。

> **这道规矩现在由机器守**：`apps/server/src/db/domain-write-guard.test.ts` 把「唯一写入方」变成断言（表/列 → 所有者），并把下面这张清单逐条登记成豁免；新增越界在 CI 就会红，清理一处只需删一行豁免。

| # | 位置 | 在写什么 | 为什么危险 |
|---|---|---|---|
| 1 | `apps/server/src/services/user.ts:53` | `UPDATE users SET energy=9999`，**不写 `energy_ledger`** | 余额与流水结构上可永久漂移；这是唯一一个「缓存有值、账本没有对应入账」的运行时写点。仅 `NODE_ENV!==production` 生效（`user.ts:36-38`） **已修**：改走 `grantEnergy`（能量唯一写入方），判据换成显式开关 `DEV_ENERGY_TOPUP`（默认关），并新增只读对账 `pnpm db:energy` |
| 2 | `apps/server/src/services/user.ts:75` | 建号 insert 时直接给 `users.energy` | 同上，且发生在「用户第一次出现」这个没有账本行的时刻 **已修**：建号只插 openid，能量改由 `withLocalDevPrivilege` 走账本补一条流水 |
| 3 | `tools/admin/server.ts:662` | `INSERT/UPDATE articles` 的整行：`is_active`、`theme`、`standard_audio`、`difficulty`、`published_at` | 难度这一列绕过 `syncArticleIndex`（`article-index.ts:73`）由 admin 直接写；`:663` 再让 syncArticleIndex 写一遍。若 `:663` 失败，库里留的是 admin 那一份 |
| 4 | `tools/admin/server.ts:880` | `UPDATE articles SET is_active`（+ 必要时 `published_at`） | `is_active` 的第二个写入方；与 `upsertArticle` 的发布逻辑是两套代码 |
| 5 | `apps/server/src/db/seed-articles.ts:86-94` | 灌库 insert：`is_active=true`、`published_at=now`、`theme` | 灌库=上线（注释自认，`seed-articles.ts:75`）。`published_at` 被写成**灌库时刻**，不是真实上线时刻；`.ignore()` 又让重复灌库不修正已有行 |
| 6 | `apps/server/src/db/seed-articles.ts:124-126` | `UPDATE articles SET standard_audio`（仅 `STORAGE=local`） | `standard_audio` 的第 2 个写入方（另有 `standard-audio.ts:204`） |
| 7 | `apps/server/src/services/standard-audio.ts:204` | `UPDATE articles SET standard_audio` | 该列本身没有「唯一写入方」的设计；运行时这一个 + admin + seed + rename 脚本，共 4 处 |
| 8 | `tools/backfill-article-theme.ts:91,93,94,105` | raw SQL 改 `articles(id,theme)`、`submissions.article_id`、`article_tags.article_id`、`submissions.theme` | 一次运维改写四张表；其中 `submissions.article_id` 与 `article_tags` 都绕过各自的写入方，且会**使 `participations` 失效**（article_id 变了，参与记录不会自动跟着重建） |
| 9 | `tools/rename-content-to-hash.mjs:98` | raw `UPDATE articles SET standard_audio` | `standard_audio` 的第 4 个写入方 |
| 10 | `tools/dev-unlock.mjs:76` | raw `UPDATE users SET member_until` | 会员概念整体已被能量取代（`services/user.ts:8-15` 注释），但仍有一列 + 一个脚本在写 |
| 11 | `apps/server/scripts/wipe-history.ts:105-119` | `DELETE participations/likes/reviews/submissions/unfreeze_cards/reward_grants/energy_ledger` + 全表 `UPDATE users` 清 streak/growth/energy | 绕过所有唯一写入方；这是 AGENT.md「验证脚本不许清库」事故的脚本本体 |
| 12 | `apps/server/src/services/unfreeze.ts:183` | `UPDATE users SET last_read_date = 昨天` | 连战输入的第二个写入方，绕过 `services/streak.ts` 的纯函数 |
| 13 | `apps/server/src/db/seed-dev-arena.ts:156,173,248` | 直接 `INSERT/UPDATE users`（streak 字段）、`DELETE/INSERT unfreeze_cards`、`INSERT submissions(status='scored')` | 绕过 `scoring/settle/streak/grantReward`：造出来的成绩没有 `growth_*` / `streak_delta` / `reward_grants`，与真实结算过的行不是一个形状。它只补了 `participations`（`:262`） |
| 14 | `apps/server/scripts/settle-smoke.ts:61,69`、`apps/server/scripts/streak-record-smoke.ts:33` | 直接 `INSERT submissions`；`settle-smoke.ts:69` 还写 `isConquered: true` | `is_conquered` 列已在迁移 0034 删除（`0034_nappy_charles_xavier.sql:25`）；`apps/server/tsconfig.json` 只 include `src/**`，所以 `scripts/` **不被 typecheck**，这个陈旧字段不会被编译器拦下——脚本一跑就报错（**待核实**：未实际执行该脚本确认） |
| 15 | `apps/server/drizzle/0038_aspiring_alex_power.sql:34` | raw `INSERT INTO participations`（整表回填） | 绕过 `syncParticipation`。它是一次性迁移、设计内有（否则迁移后榜单全 0，见该文件 `:22-27`），但确实是「第二个写入方」 |
| 16 | `apps/server/src/db/schema.ts:479`（列）+ `tools/backfill-article-theme.ts:105`（唯一写点） | `submissions.theme` | 运行时不写、全仓库无读者（`apps/server/src` 与 `packages/shared` 的 grep 无命中）；唯一写入方是一个一次性回填脚本。它是「快照」这条业务概念的遗留列 |

**关于「脚本算不算正常入口」的问法与回答：**
- `apps/server/scripts/rebuild-participations.ts:22` 与 `apps/server/src/db/seed-dev-arena.ts:262` 调的是 `rebuildParticipations`（`participations.ts:207`）——**算正常入口，不是越界**。它们没有直接写 `participations`（直接写只在 `participations.ts:134,290`）。
- 上表 8/9/10/11 是 raw SQL 运维脚本，13/14 是直插冒烟脚本——**都不算正常入口**。
- 迁移 0038 的 `INSERT` 是一次性回填，**不算运行时入口**。

**关于 `articles` 的「谁是唯一写入方」的明确回答：**
- `articles.difficulty` / `article_tags`：**两个都算写入**（`article-index.ts:73` 与 `admin/server.ts:650,662`）。没有唯一写入方。灌库 `seed-articles.ts` 只间接写（经 reindex）。
- `articles.is_active/published_at`：admin 两处 + 灌库一处，**没有唯一写入方**。
- `articles.standard_audio`：4 处，**没有唯一写入方**。
- `articles.theme`：3 处，**没有唯一写入方**（且可由 id 纯函数复算）。

---

## 三、最危险的 5 个点（按风险排序）

1. **`settle` 跨多个事务，且失败后无补偿入口。** 哪里：`services/settle.ts:47` 内部分别写 `users.streak_*`（`streak.ts:100`）、`submissions+users.growth_*`（同事务，`settle.ts:98-140`）、`reward_grants/energy_ledger/unfreeze_cards`（`rewards.ts:241`）、`users.unfreeze_marker_streak`（`rewards.ts:167`）。会出什么错：提交停在 `status='scored'` 但 `growth_self IS NULL`，连战已加、成长值缺失、奖励可能已发但记账位没推进（后者**待核实**：未运行时复现，但按 `rewards.ts:154,167` + `reward_grants` 幂等键的代码逻辑，marker 不推进会让后续跨档判定一直被幂等键挡回）。怎么发现：理论上查 `submissions WHERE status='scored' AND growth_self IS NULL`——**没有任何命令或对账脚本做这件事**。
2. **`articles` 的五个属性列各有 2–4 个写入方。** 哪里：`admin/server.ts:662,880`、`seed-articles.ts:86-94,124`、`standard-audio.ts:204`、`backfill-article-theme.ts:91`、`rename-content-to-hash.mjs:98`。会出什么错：下架被灌库覆盖、`published_at` 记成灌库时刻、`difficulty` 与正文 `scores` 分叉、`standard_audio` 指向不存在的音频。怎么发现：难度/标签有 `pnpm content:regrade --apply`（`article-index.ts:109` 的 `reindexArticles`）可覆盖回正文；但 `is_active/published_at/standard_audio/theme` **没有对账命令**。
3. **能量余额可绕过账本直写，且无对账。** 哪里：`services/user.ts:53,75` 直接 `UPDATE/INSERT users.energy`，不写 `energy_ledger`。会出什么错：`SUM(energy_ledger.delta) ≠ users.energy`，而所有读余额的接口都走 `readEnergy`（`energy.ts:88`）读缓存，界面看起来完全正常。怎么发现：**无**——全仓库没有比对命令或测试。
4. **解冻卡 / 连战被脚本直写。** 哪里：`seed-dev-arena.ts:169,173` 直插删卡、`unfreeze.ts:183` 直改 `last_read_date`、`wipe-history.ts:105-119` 全表清。会出什么错：卡没有对应的 `reward_grants` 幂等记录（规则 B 可重复发的风险面）、`last_read_date` 的改写不经过 streak 纯函数、清库脚本一次抹掉用户资产。怎么发现：卡的三条判据可从 `unfreeze_cards` 现算（`unfreeze.ts:34`），但**没有**把卡与 `reward_grants` 对上的命令。
5. **评测中间态没有回收任务。** 哪里：受理时一次事务只锁能量、写 `status='scoring'`（`routes/submissions.ts:169,187,203`），回收完全依赖客户端轮询（`routes/submissions.ts:255-261` 的 `claimStaleScoring`）。会出什么错：用户不轮询（关掉小程序）→ 行永远 `status='scoring'`、`energy_state='held'`，那 2 点能量**永久占住**；全仓库无 cron/定时清理（`grep setInterval|cron` 只命中心跳与 TTS 超时）。怎么发现：查 `submissions WHERE status='scoring' AND heartbeat_at < now-30s`——**没有命令**。

**另外两个不排进前五、但确实存在的口子：**
- `SubmitResponse.attempts`（= **"这一句上的第几次"**，只数**有结论**的行：`scored` + 引擎判无效；
  由 `services/submission.ts` 的 `attemptNoOf()` **读的时候现算**，`submission-view.ts` 用它）与
  `participations.attempts` / `ArenaRecord.attempts`（**只算 scored**，`participations.ts`）**口径不同，
  且会同时出现在界面上**：结果页 s5 显示「第 K 次朗读」（K = 前者），首页卡片显示「你已经参与 N 次挑战」
  （N = 后者）。有「引擎判无效」的提交时 K > N。两处差异是**有意**的，但同一个词 `attempts` 在两个类型里
  是两个口径。
- ⚠️ **"第几次"不再是库里的列**（`submissions.seq` 已于迁移 0051 删除）：它是个**显示位置**，
  存下来就要养分配器、`(user, article, seq)` 唯一索引、撞号重试和重编号脚本 ——
  而那个分配器**真的把服务进程搞崩过**（并发撞唯一键 + 异常逃逸）。现在列表按行序现算、
  s5 按 `attemptNoOf()` 统计，两者同一个口径 ⇒ 序号天然连续，不可能有空洞。
- **业务规则在端侧重算。** `packages/shared` 与端侧确实存在「服务端已给、端侧又算一遍」：`resolveTheme(theme, articleId)` 在有 id 时按 `themeFromHash` 复算主题（`packages/shared/src/theme.ts:98-105`，调用点 `apps/miniprogram/src/pages/challenge/challenge.ts:294`）；首页端侧再按 `articleId !== today.articleId` 过滤一次 latest（`apps/miniprogram/src/pages/index/index.ts:623`，因为服务端剔除的是排期那句、判据不同，见 `:611-617`）。（2026-09 删掉了最后一处：`store.applySubmissionResult` 原来在端侧把 `myAttempts + 1` / `myBest = max(...)`，那套影子连同 `arena-records` 一起去掉了 —— 战绩只由 `/api/user/participation/{articleId}` 写进 store。）
  而题面点名的三个：`subtitleOf`（`reading.ts:1583`，输入全是服务端字段 `previousBest/isPersonalBest/rank/beatenCount`）、`formatScore`（`packages/shared/src/scoring.ts:190`，纯展示）、`startButtonLabel`（`packages/shared/src/brand.ts:42`，只吃服务端 `myBest !== null`）——**都是展示层/由服务端事实派生，不算把服务端才算得出的东西重算**。真正值得记的是上面三条。

---

## 四、待核实清单

| 结论 | 为什么拿不准 |
|---|---|
| `rewards.ts:167` 的 marker 更新若在 `grantReward` 之后失败，会让该用户后续跨档奖励被幂等键永久挡回 | 代码逻辑可推，但未在运行时复现；也没有测试覆盖这个崩溃点 |
| `energy_ledger` 与 `users.energy` 当前是否已经漂移 | 只读了代码，未连库执行 `SUM(delta)` 与余额的比对 |
| `submissions.theme` 在历史数据里是否普遍为 NULL | 未查库；只确认了运行时代码不写它 |
| `apps/server/scripts/settle-smoke.ts:69` 的 `isConquered` 是否已让该脚本实际跑不通 | 未执行脚本；只确认了 `scripts/` 不在 `apps/server/tsconfig.json` 的 `include` 里，编译器拦不住 |
| `seed-dev-arena` 造的 `status='scored'` 行没有 `growth_*` 快照，是否会让 dev 环境的成长榜/结果页与真实口径看起来不一致 | 未跑 `pnpm seed:arena` 后查库核对；只读了脚本代码 |

import { sql } from 'drizzle-orm'
import {
  mysqlTable, int, varchar, boolean, datetime, decimal, text, json, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/mysql-core'
import {
  ARTICLE_ID_LENGTH,
  SUBMISSION_ID_LENGTH,
  type ArticleTheme,
  type ArticleWordItem,
  type DifficultyScores,
} from '@jushuo/shared'

/**
 * 数据模型（与用户对齐后的最终版）。
 *
 * ⭐ 命名原则：**「竞技场」是抽象概念，不落到表名上**。
 *    朗读单元直接叫 articles；提交记录叫 submissions。
 *
 * ⭐ 内容不入库：articles 只是**索引**——正文 / 技巧 / 标准音都是静态资源引用，
 *    库里只留「能被索引和排序」的字段（排期 / 竞技统计）。
 *
 * ⚠️ 分类已经**整体下线**；难度作为**正文属性**重新加回来了
 *    （写在 content/articles/*.json 里，见 shared/level.ts）。
 *
 * ⭐ **难度只有一个档位**（difficulty）—— 但判的时候要分**三个判据**想：
 *    词汇及句式（×5）/ 发音（×3）/ 句子长度（×2），各 1–5 分。
 *    判据是**判据**，不是字段（2026-09 用户纠正）：用户看到的是一枚徽章 + 一句「难在哪」。
 *    合成规则（**算术在代码里**，见 shared/level.ts）：
 *      score = (5×词汇 + 3×发音 + 2×长度) / 10（1–5）→ **四舍五入到整数**：
 *      1–2 初级 / 3 中级 / 4 高级 / 5 专家（切分点 2.5 / 3.5 / 4.5）
 *      ⚠️ 不是 [3,4) 就算高级 —— 词汇只到高中（2）的句子光靠发音顶多是中级。
 *    ⚠️ 三个判据分记在正文 JSON 的 `scores` 里 —— 那是为了让档位**能被代码验算**，不进这一列。
 *
 * ⭐ 难度**另有一份派生索引**：articles.difficulty（标签的派生表已删，见下面那段说明）。
 *    · **真相永远是正文 JSON**；这两处只是「能被 SQL 筛选 / 排序」用的副本；
 *    · 由 services/article-index.ts 的 syncArticleIndex 从正文物化（幂等）；
 *    · 内容改了要重跑（CLI 的 reindex；导入 / 新增句会自动跑）。
 *    ⚠️ 不要手写这三处 —— 与正文不一致时，以正文为准重跑 reindex。
 *
 * 📌 注释里说的「正文 JSON」= content/articles/<id>.json；「档位」= 0 初级 / 1 中级 / 2 高级 / 3 专家。
 *    历史迁移 0003 / 0004 是当年分类那两列的删除过程。
 *
 * ⚠️ MySQL 的 DATETIME 不存时区 —— 全链路按 UTC 读写（见 db/index.ts 的 timezone 设置）。
 */

export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  openid: varchar('openid', { length: 64 }).notNull().unique(),
  unionid: varchar('unionid', { length: 64 }),
  nickname: varchar('nickname', { length: 64 }),
  avatarUrl: varchar('avatar_url', { length: 512 }),

  /** 性别：'male' | 'female'；null = 未填 */
  gender: varchar('gender', { length: 16 }),
  /** 年龄（岁）：6–120；null = 未填 */
  age: int('age'),
  /** 简介：最多 200 字；null = 未填 */
  bio: varchar('bio', { length: 200 }),


  /** 账号状态：normal | banned | deleted（防刷只有「当日暂停」是不够的，需要长期维度） */
  status: varchar('status', { length: 16 }).notNull().default('normal'),

  /** ⭐ 冗余会员到期时间 —— 「是不是会员」是热判断，不值得每次 join subscriptions */
  memberUntil: datetime('member_until', { mode: 'date', fsp: 3 }),

  // ⚠️ 这里原来有一列 next_free_at（24 小时滚动冷却的"下次可免费提交时间"）。
  //    冷却已下线，改成「**每句额度**（免费 1 次 / 付费 20 次）+ 固定间隔 2 分钟」——
  //    额度**从 submissions 现算**，不在 users 上存副本：
  //    存了就是第二份真相，而它必然和 submissions 漂移
  //    （补签、删记录、迁移，任何一次都会让两者对不上）。
  //    见 services/quota.ts 与迁移 0012。

  /** 无效提交计数（防刷） */
  invalidCount: int('invalid_count').notNull().default(0),
  invalidDate: varchar('invalid_date', { length: 10 }),

  // ----------------------------------------------------------------
  // ⭐ Streak（连续朗读天数）—— 做减法后的三条核心之一
  //
  // ⚠️ 这四个字段是**用户资产**，规则全部集中在 shared/streak.ts 的纯函数里，
  //    路由只负责「读出来 → 交给纯函数 → 写回去」。
  //    任何把跨天判断写进路由的改动都会让这套数字没法单测，也就没法信任。
  // ----------------------------------------------------------------
  /** 当前连续天数 */
  streakDays: int('streak_days').notNull().default(0),
  /**
   * 历史最长连续天数 —— **只增不减**。
   *
   * ⚠️ 等级徽章已整体废除（见 docs/design/growth-and-energy.md），
   *    它现在的用途只剩展示（我的主页上的「历史最长」）。
   * ⚠️ **坚持不懈用的是 streakDays 的跨档，不是它** —— 跨档是事件，只发生一次；
   *    拿 streakBest 判会变成「到过就永远算」，那是另一回事。
   */
  streakBest: int('streak_best').notNull().default(0),
  /** 最后一次计入 streak 的自然日 'YYYY-MM-DD'（北京时间）。never read 时为 null */
  lastReadDate: varchar('last_read_date', { length: 10 }),

  // ⚠️ 这里原来有一列 freeze_count（解冻卡的**计数器**）。
  //    现在删掉了，两个原因：
  //      ① 解冻卡要**有效期**，"手上还有几张"已经不是一个整数能表达的（每张卡有自己的到期日）
  //         ⇒ 改成一张卡一行（unfreeze_cards），余额从那里现算
  //      ② 存量计数器就是第二份真相，必然和卡表漂移
  /**
   * ⭐ 上次发解冻卡时的 streakDays —— 奖励规则 A（连续 7 天发 1 张）用。
   * ⚠️ 它让发卡变成**事件**而不是状态函数：发过一次就推进一次，
   *    改阈值不会追溯重发（见 docs/design/reward-system.md 第 2 节）。
   * ⚠️ 断档（streakDays 变小）时它归 0，计数从头。
   */
  unfreezeMarkerStreak: int('unfreeze_marker_streak').notNull().default(0),

  // ----------------------------------------------------------------
  // ⭐ 成长值（三个独立指标，**分开展示、不合成总分**）
  //
  // ⚠️ 这三个是**累加值**；每一次提交的明细在 submissions 的快照列里。
  //    两者分工：这里回答"我一共多少"，那里回答"这一次为什么是这些分"。
  // ----------------------------------------------------------------
  /** 自我超越（句子内 + 个人全局，各占一半后取平均） */
  growthSelf: int('growth_self').notNull().default(0),
  /** 坚持不懈（跨过 7 / 30 / 180 / 360×k 里程碑） */
  growthDiligence: int('growth_diligence').notNull().default(0),
  /** 人中翘楚（与榜单中位数的差距 × 样本量权重） */
  growthStandout: int('growth_standout').notNull().default(0),

  // ----------------------------------------------------------------
  // ⭐ 能量值（替代"每天 N 次挑战机会"）
  //
  // ⚠️⚠️ 与旧的额度**最大的结构差别**：额度每天重置、可以从 submissions 现算；
  //    能量**跨天留存**（昨天剩的点数今天还在），所以必须落库。
  //    但余额是**缓存**，真相在 energy_ledger 的流水里，两者必须同事务写。
  // ----------------------------------------------------------------
  /** 能量余额（整数点；每次挑战 2 点、每日补足到 3 点） */
  energy: int('energy').notNull().default(0),
  /** 最后一次"补足"的日期 'YYYY-MM-DD'（惰性 + 幂等，见 growth-and-energy.md 2.3） */
  energyDate: varchar('energy_date', { length: 10 }),

  // ----------------------------------------------------------------
  // ⭐ 今日推荐窗口（2026-09 用户定的口径：**以用户为单位，每 24 小时换一次**）
  //
  // ⚠️⚠️ 为什么必须落库、不能现算：
  //    「这一句在今天这个用户这里不变」这件事**没有别的地方能表达**。
  //    推荐是按参与记录算出来的（services/recommend.ts），而参与记录随时会因为
  //    「刚读完这一句」而变 —— 现算的话，用户读完返回首页就会看到卡片换成另一句
  //    （这个 bug 真实发生过：他的当天成果跟着一起没了）。
  //    落两列之后，24 小时内一律以**库里那一句**为准。
  //
  // ⚠️ today_assigned_at 的语义是「**这一个窗口从哪一刻开始**」，
  //    不是「这一句的发布日期」。窗口 = [assigned_at, assigned_at + 24h)。
  //    选句按 assigned_at 所在的**自然日**取模（见 recommend.ts）——
  //    这样同一天开始窗口的人拿到同一句，任意时刻每档最多两句在飞。
  // ----------------------------------------------------------------
  /** 当前 24 小时窗口分给我的那一句；null = 还没分配过 */
  todayArticleId: varchar('today_article_id', { length: ARTICLE_ID_LENGTH }),
  /** 当前窗口的起始时刻（UTC）；null = 还没分配过 */
  todayAssignedAt: datetime('today_assigned_at', { mode: 'date', fsp: 3 }),

  // ----------------------------------------------------------------
  // ⭐ 虚拟支付要用的登录态
  // ----------------------------------------------------------------
  /**
   * ⭐ 登录态 session_key —— 虚拟支付的**用户态签名**要用它。
   *
   * ⚠️ 它只能从 auth.code2Session 拿到。而线上主通道是 callContainer
   *    （openid 由网关注入）——**那条路上没有 session_key**。
   *    所以下单前允许端侧补一个 wx.login 的 code，服务端换一次再落库
   *    （见 routes/auth.ts 的 /session 与 routes/shop.ts 的提示）。
   *
   * ⚠️ 它是**敏感凭证**（等同于登录态）：只存库、绝不下发，
   *    也不要写进日志。
   * ⚠️ 会过期：微信侧报 -15007 时重新换一次即可。
   */
  sessionKey: varchar('session_key', { length: 64 }),
  /** session_key 的获取时间 —— 微信不给过期时间，只能按新鲜度自己估 */
  sessionKeyAt: datetime('session_key_at', { mode: 'date', fsp: 3 }),

  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

/** 朗读单元（文章 = 句子）。内容走静态资源，这里只放索引与竞技状态/统计 */
export const articles = mysqlTable('articles', {
  /**
   * ⭐ 文章 ID = **内容 hash**（`sha256(text)` 的十六进制**前 ARTICLE_ID_LENGTH 位**）。
   *    content-addressed：同一段文本在任何环境都是同一个 ID；
   *    内容一改就是**新文章**（老提交/排期仍指向老正文，逐词对齐不会被改后的正文带偏）。
   *    ⚠️ 长度是 16（64 bit）—— 取多少、为什么，写在 shared 的 constants。
   */
  id: varchar('id', { length: ARTICLE_ID_LENGTH }).primaryKey(),
/**
   * ⚠️⚠️ 这里**曾经有一列 `content_json`**（正文的静态路径），已删除。
   *
   *    它是**第二个真相**：两个写入方（后台发布 / 部署灌库）都写
   *    `'/content/articles/' + id + '.json'`，而这个式子里的 id 就是内容 hash ——
   *    路径**完全可推导**（见 services/content.ts 的 contentPathOf）。
   *    存下来的唯一后果是：它能跟 id 漂移，而没有任何东西检查两者一致。
   *
   *    当初加它的理由是「正文将来可能放 CDN 绝对地址」。但 CDN 会镜像同一套
   *    相对路径，变的只是**根**（STATIC_ROOT / CDN base），不是每条记录的路径 ——
   *    所以这个理由也不成立。
   */
  /**
   * ⚠️⚠️ 这里**曾经有一列 `tips_json`**（朗读技巧 JSON 地址），已删除。
   *
   *    它和 content_json 是同一种病：一个**没有任何写入方的声明**。
   *    技巧流水线一直没建，全仓库没有一处读、也没有一处写（spec.md 自己都标着
   *    「该流水线未建，全链路没人读写」）。JSON 地址又是 `content/tips/<id>.json`
   *    这种完全可推导的形状 —— 真做起来也该按 id 推导，不该存。
   *    ⇒ 与其留一列等人去猜「它是不是有用」，不如删掉；要用时按 id 推导即可。
   */
  /**
   * ⭐⭐⭐ **正文 —— 拆成列存在 articles 上**（2026-09 用户定：内容只走 admin，且一列 = 一个事实）。
   *
   * ⚠️⚠️ 这里**曾经是一整列 JSON `content`**，已拆散（迁移 0045）。为什么不继续用 JSON：
   *    · 一份 JSON 里混着"根数据"（text）与"派生值"（difficulty / tags）与"完全重复"（id）；
   *    · 数据库看不见里面的字段 —— 想按难度筛、想给译文建全文索引都做不到；
   *    · 改一个字段要整份读改写（并发下是丢更新的经典形态）。
   *    ⇒ 现在一列一个事实，下面每一列都标了"它是源还是派生"。
   *
   * ⚠️ 只把**结构化的列表**留成 JSON 列（words / links / scores / tags）：
   *    它们是与这一行**一对多、按顺序**的东西，拆成表要么丢掉下标语义、
   *    要么每次读都多一次 join，而实际查询从来只按 article_id 整取。
   */
  /**
   * ⭐ **句子原文** —— 这道题的根，评分时的参考文本。
   * ⚠️ 它是**一切派生值的源头**：词表由它切出、字数/判据由它算。
   */
  text: text('text'),
  /** 译文（运营可改；与原文一样属于"内容本身"） */
  translation: text('translation'),
  /**
   * ⭐ **三个判据分 [词汇, 发音, 长度]**（`DifficultyScores`）——
   * ⚠️⚠️ **它才是难度的源**：`articles.difficulty` 由它算出来（`difficultyFromScores`）。
   *    以前 schema 的注释把这件事写反了（说"真相在正文的 difficulty 里"），
   *    而代码一直是"从 scores 算 difficulty" —— 注释与实现相反正是数据模型说不清的根源。
   * ⚠️ 可空：老内容可能没评过分。缺就是缺，**不补默认分**。
   */
  scores: json('scores').$type<DifficultyScores>(),
  /**
   * ⭐ **挑战宣言**（给用户看的第一句，≤18 字，不带末尾标点）。
   * ⚠️ 分享卡标题要用它（客户端拼「朗读挑战:」+ 它），所以字数上限是硬的。
   */
  challenge: varchar('challenge', { length: 64 }),
  /** ⭐ **朗读建议**（给用户看的第二句，接在 challenge 后面） */
  advice: text('advice'),
  /**
   * ⭐ **词表**（`ArticleWordItem[]`，朗读页逐词显示与点按的全部数据）——
   * 结构与顺序都属于内容：`words[i]` 与正文里第 i 个词对齐。
   */
  words: json('words').$type<ArticleWordItem[]>(),
  /**
   * ⭐ **词间连读标注**，与 words 一一对应（`links[i]` 描述 words[i] 与 words[i+1] 之间；
   * 空串 = 这里不连）。长度必须是 `words.length - 1`。
   */
  links: json('links').$type<string[]>(),
  /**
   * ⚠️ **过渡列，即将删除**：这里曾经是整份正文 JSON（`ArticleContent`）。
   *    上面那 7 列就是把它拆散的产物（2026-09 用户定：一列 = 一个事实）。
   *    分两步发：① 先加那 7 列（旧代码照跑）；② 下一次部署再删这一列。
   *    ⇒ 现在这一列**没有任何读写方**，留着只是为了让第一个迁移别顺手把它删掉。
   */
  content: json('content'),
  /** 标准发音 MP3 地址 */
  standardAudio: varchar('standard_audio', { length: 512 }),
  /**
   * ⭐ 视觉主题 —— { image, background, foreground }（见 shared 的 ArticleTheme）。
   * ⚠️ 整份可空：老内容没有主题，端侧退回默认配色。
   */
  theme: json('theme').$type<ArticleTheme>(),
  /**
   * ⭐ **朗读难度**的派生索引（0 初级 / 1 中级 / 2 高级 / 3 专家）—— **只有这一列**。
   *
   * ⚠️ 真相在正文 JSON 的 `difficulty` 里（见 shared/level.ts）——
   *    这一列只是让「按档位筛选 / 排序」能走 SQL，**不是第二份真相**：
   *    正文改了要重跑 syncArticleIndex（CLI: reindex），它是幂等的。
   * ⚠️ 可空：正文没写（或还没评过级）就是 NULL ——
   *    **绝不填默认档位**（见 normalizeLevel 的说明）。
   * ⚠️ 词汇 / 发音 / 长度都是**判据**，不是列（2026-09 用户纠正）：
   *    判的时候分三个判据想、按权重合成一个档位（见 shared/level.ts），不要为它们各开一列。
   */
  difficulty: int('difficulty'),
  /**
   * ⭐ **标签**（`string[]`）—— 与正文里的 `tags` 同一份内容，做成列是为了**可查、可列表展示**。
   *
   * ⚠️ 为什么是"articles 上的一列"而不是一张 `article_tags(article_id, tag)` 关联表：
   *    关联表当初的理由是"独立成表才能按单个标签索引"，而那个用途**从未实现**，
   *    代价却是实打实的 —— 它 `(article_id, tag)` 的形状**丢掉顺序**（第一个标签最重要），
   *    admin 详情页因此得专门写一段"优先用正文、索引只兜底"来绕开它；
   *    而全仓库没有任何"按标签筛选"的查询。⇒ 2026-09 删表，改成这一列。
   *
   * ⚠️ 它**仍是派生值**（真相是 `articles.content.tags`）：由 `syncArticleIndex` 幂等物化，
   *    可随时全量重建。规矩与 `difficulty` 完全一样：**只由那一处写**。
   * ⚠️ 用 JSON 数组而不是逗号串：标签本身可能含空格/标点，逗号串要靠分隔符猜测边界。
   */
  tags: json('tags').$type<string[]>(),
  /**
   * ⭐⭐ **发布状态 —— 全仓库唯一的那个真相**（列名 is_active，语义是「已发布 / 在线」）。
   *
   * ⚠️⚠️ 这里**曾经有两列**：content_status 与 is_active，注释说它们「是两回事：
   *    内容先发布、再决定开不开竞技」。但那个区分**从来没有被实现过**：
   *      · 两个写入方（后台 upsertArticle / 部署灌库）永远把两列写成**同一个值**；
   *      · 产品侧（客户端、排期轮转、后台列表与详情）**只读 is_active**；
   *      · apps/server 的运行时**一次都没读过 content_status**。
   *    于是它只是一份同义的副本，代价却是实打实的：两列各有 DB 默认值，
   *    而默认值互相矛盾（content_status 默认 'draft'、is_active 默认 true）——
   *    灌库路径插出来的行就是「草稿但在线」，后台按 content_status 判会拒绝一条
   *    明明在线的句子（tools/admin 里踩过，见那里的注释）。
   *    ⇒ 删掉 content_status（迁移 0033）。将来真需要「发布」与「开竞技」分开，
   *      那是一个**新概念**，要带着它自己的语义与约束出现，而不是这个名字的副本。
   */
  isActive: boolean('is_active').notNull().default(true),
  /**
   * ⚠️⚠️ 这里**曾经有两列** `participant_count` / `conquered_count`
   *    （「参与人数」「攻克人数」的冗余计数），已删除（迁移 0034）。
   *
   *    它们**没有任何代码在读**：竞技口径一律**从 submissions 派生**
   *    （当时是 services/leaderboard.ts 的 `COUNT(DISTINCT user_id)`，
   *      routes 里所有 participantCount 都走它）。
   *    写入方却有两个：scoring 打分成功时自增、dev 种子脚本按 submissions 重算
   *    （那个脚本的注释自己就写着「这两列没有任何代码在读」）。
   *
   *    于是它们是一份**只写不读**的副本，唯一的下场是在库里慢慢和真相分叉 ——
   *    而且 scoring 里那次自增读的还是 submissions.is_conquered
   *    （一个全仓库别处都因为「老数据按已废除的 85 线写」而拒绝读的列）。
   *    ⇒ 「几个人参与 / 几个人攻克」只有一个**真相**：**submissions 表**。
   *
   *    ⚠️ 2026-09 这里又多了一张 **participations**（一人一行，见下面那张表）：
   *       它不是这两列的翻版 —— 那两列是**只写不读**的计数副本、有两个写入方；
   *       participations 有明确的读者、**唯一写入方**、而且能整表重建（迁移 0038）。
   */
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  /**
   * ⚠️ 这里**曾经有一列 `updated_at`**，已删除。
   *
   *    它没有 ON UPDATE 子句 —— 只有代码显式写才会变，而全仓库**没有一处写它**，
   *    于是每一行的 updated_at 恒等于 created_at：一列在**说谎**的时间戳。
   *    它也从没被读过（唯一的读者是这条注释）。下面 publishedAt 的注释里
   *    早就写着「为什么不用 updatedAt：它实际等于 createdAt」，那就是删除的理由。
   */
  /**
   * ⭐ **发布时间**（首次/最近一次从草稿变成已发布的那一刻）。
   *
   * ⚠️ 为什么不复用 createdAt：两者不是一回事 ——
   *    草稿可以在生成后很久才发布，而 createdAt 是「生成了这一句」的时间。
   *    内容管理台的列表要按「什么时候上的线」看，用 createdAt 会答非所问。
   * ⚠️ 为什么不用 updatedAt：它**没有** ON UPDATE 子句，只有代码显式写才会变，
   *    实际等于 createdAt，同样答非所问。
   * ⚠️ 下架（isActive=false）**不清空**它：它记录的是「最近一次上线的时刻」，
   *    草稿状态另有 content_status / is_active 两列表达。
   */
  publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
})

/**
 * ⚠️⚠️ 这里**曾经有一张 `schedules` 表**（date / article_id / source / created_at），
 *    2026-09 删除（用户定：**删掉 schedules 表与接口，统一用 today 接口**）。
 *
 *    它编码的是"**哪一天读哪一句是提前排好的数据**"：按天号轮转 + 运营指定 + 预排两周。
 *    替代它的是 `/api/user/today`：
 *      · **以 24 小时为单位**（`users.today_article_id` + `users.today_assigned_at`）
 *        —— 一个用户在一个窗口里固定读同一句；
 *      · **按这个用户的难度档**推荐（services/recommend.ts）。
 *    ⇒ "日期"因此不再是内容的一部分，只是**归属信息**（这次提交算哪一天，
 *      见 services/schedule-date.ts）—— 所以 `submissions.schedule_date` 那一列留着。
 *
 *    ⚠️ 被这张表一起带走的分支（别在别处再长回来）：
 *      预排两周（scheduleAhead）· 运营排期（admin 的排期面板）·
 *      "回到那一天看那一场"（GET /api/schedules/:date）· `isScheduled` 字段。
 */

/**
 * ⚠️⚠️ 这里**曾经有一张 `article_tags` 表**（(article_id, tag) 两列），2026-09 删除。
 *
 *    它只有一个写入方（services/article-index.ts 的 applyIndex）和**零个查询方**：
 *    · 服务端从不 select 它 —— 客户端与各路由的标签都从正文取（normalizeTags(content.tags)）；
 *    · 全仓库没有任何"按标签筛选/排序"的查询（只有一句注释设想将来会有）；
 *    · 它 `(article_id, tag)` 的形状还会**丢掉顺序**，而标签顺序有意义（第一个最重要）——
 *      admin 详情页因此专门写了一段"优先用正文、索引只兜底"来绕开它。
 *
 *    ⇒ 一个没人查的派生表 = 每次内容变更都要重建，还多一份可能与正文不一致的副本。
 *    ⚠️ 留下的对照：`articles.difficulty` **真被查询**（recommend.ts 的 where / order by），
 *      所以难度那一半保留。判断标准是"有没有查询方"，不是"看起来像不像索引"。
 */

/** 提交记录 —— 每次一条，永久保留 */
export const submissions = mysqlTable('submissions', {
  /**
   * submissionId = sha256(`jushuo:<userId>:<articleId>:<seq>`) 的**前 SUBMISSION_ID_LENGTH 位**，
   * 由服务端算（services/audio-key.ts）。
   * ⚠️ 长度在 shared 的 constants 里定义一处：派生函数、这个列宽、
   *    以及路由里校验 sid 的正则都引用它（这三处曾经漂过：派生 24、列宽 40）。
   */
  id: varchar('id', { length: SUBMISSION_ID_LENGTH }).primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  articleId: varchar('article_id', { length: ARTICLE_ID_LENGTH }).notNull().references(() => articles.id),
  /** 该用户在该文章的第几次提交，从 1 开始 */
  seq: int('seq').notNull(),

  /**
   * ⭐ 这次提交是**针对哪一天的挑战**（'YYYY-MM-DD'，北京时间）。
   *
   * ⚠️⚠️ 为什么必须有这一列，而不是用 createdAt 现算：
   *
   *   ① 产品单位是「每日挑战」，而句子是**轮转**的 —— 只有 5 句，
   *      同一句每 5 天就会再出现一次。只按 articleId 统计的话，
   *      （现在竞技数据已经整体改成按 articleId 了，这一条只剩留痕的意义。）
   *   ② 提交与完成是**跨天**的：今天 23:59 提交、明天 00:00 才打完分，
   *      用 createdAt 会把它算到明天，而用户明明是在读今天那一句。
   *   ③ 用户可以对**往日的排期**点「重新朗读」，那一次是从哪一天进来的要留痕。
   *
   *   所以它是**客户端声明、服务端校验**的一个显式字段，不靠时间戳反推。
   *
   *   ⚠️⚠️ 它**不参与任何竞技口径** —— 排名、参与人数、最高分全部按 article_id 查。
   *      它只回答「这次是从哪一天的排期进来的」，是个活动记录。
   *      所以它叫 schedule_date（排期）而不是 challenge_date（挑战）：
   *      后者会让人以为「某一天的挑战」是个带成绩的东西，而这一列从来不是。
   */
  scheduleDate: varchar('schedule_date', { length: 10 }),


  /**
   * scoring = 已受理、正在打分；scored = 检测成功（音频永久保留）；failed = 检测失败（音频已删）。
   *
   * ⚠️⚠️ scoring 是一个**必须能查到的真实状态**，不是过渡态。
   *    打分要 10–20 秒，而云托管 callContainer 单次超时上限只有 15 秒 ——
   *    「请求先返回、打分在后台继续」是这条链路的**唯一正确形态**。
   *    客户端拿到 submissionId 后轮询本行，服务端按这个状态回答「还没好 / 好了 / 挂了」。
   */
  status: varchar('status', { length: 16 }).notNull(),

  /**
   * ⭐ 打分进程的**心跳** —— 由正在跑评测的那个请求每几秒刷新一次。
   *
   * ⚠️⚠️ 为什么是心跳，而不是「createdAt + 固定秒数」：
   *    固定秒数等于给打分**设了一个时长上限** —— 句子长一点、引擎慢一点，
   *    任务就会被误判成死掉并重跑，用户永远拿不到分。
   *    心跳证明的是「那个进程还活着」，与总分时长无关：
   *    跑 60 秒也行，只要它每 5 秒心跳一次。
   *    ⇒ 这里没有任何「打分最多能跑多久」的假设。
   */
  heartbeatAt: datetime('heartbeat_at', { mode: 'date', fsp: 3 }),

  /**
   * 这段音频被**尝试打分的次数**。
   * ⚠️ 它是防死循环的闸，不是时长上限：进程被杀 → 心跳超时 → 接管重跑，
   *    但同一条音频最多重跑 MAX_SCORING_ATTEMPTS 次，之后判 failed 并让用户重录。
   */
  attempts: int('attempts').notNull().default(0),
  /**
   * ⭐ 总分 0–100，**保留一位小数**。
   *
   * ⚠️⚠️ 为什么不用整数：这是个排行产品，整数分会让大量人卡在同一个分上，
   *    名次只能靠与朗读无关的顺序（谁先提交）决定 —— 而用户看到的是
   *    「我 78 分第 9 名、他也 78 分第 9 名」。一位小数把并列砍掉一大半。
   * ⚠️ 用 DECIMAL 而不是 FLOAT：分数要参与比较与并列判定，
   *    浮点的表示误差会让"看起来相等"的两个分在某些位上不相等。
   * ⚠️ drizzle 读 DECIMAL 回来是**字符串**，用之前必须 Number() ——
   *    tsconfig 会逼着你处理（这也是选它的副作用，好处是不会静默当成数字用）。
   */
  score: decimal('score', { precision: 5, scale: 1 }),
  /**
   * ⚠️⚠️ 这里**曾经有一列 `is_conquered`**，已删除（迁移 0034）。
   *
   *    它的语义被改过两次，最后退化成 status 的同义词：
   *    攻克原本是「85 分以上」，那条线废除后改成「出分即可」——
   *    **能走到写 score 的地方就说明已经出分**，所以写入方一律写 true。
   *    但**老数据是按 85 线写的 false**，于是这一列对历史提交是错的。
   *
   *    全仓库其它地方早就改成按 `status === 'scored'` 判定了
   *    （submission-view / user.ts / conquest.ts 都留了「不要读那一列」的注释），
   *    只剩 scoring 里还在读它来数「是不是第一次攻克」——
   *    一个大家都声明不可信的列，不该还留着让人再去读一次。
   *    ⇒ 攻克的口径只有一条：**submissions.status = 'scored'**。
   */

  /**
   * ⭐⭐ **一次"提交尝试"的稳定 id**（客户端在录音落地那一刻生成，重试复用）。
   *
   * ⚠️⚠️ 为什么幂等键不能是 audioKey（2026-09 修的真实缺陷）：
   *    audioKey = `audio/{articleId}/{userId}/{Date.now()}.{ext}` —— 它是**上传时刻**的
   *    时间戳，而客户端每次重试都会**重新上传一次**（reading 页的退回 s3 → 用户再点 ✓）。
   *    ⇒ 同一次录音、两个不同的 key ⇒ 幂等查库必然落空
   *      ⇒ 第二条 submissions 行、**第二次扣 2 点能量**、第二次调引擎。
   *    而界面上明写着"再点一次即可…**不会重复计费**" —— 承诺与实现相反。
   *    更糟的是打分成功后会把这个列改写成 mp3 存档路径，**幂等键自己被改掉**。
   *    ⇒ 幂等键必须**与物理存储无关、且在一次尝试的整个生命周期里不变**。
   *
   * ⚠️ 可空是留给历史行的（那时还没有这个字段）；新写入一律由代码保证非空。
   */
  attemptId: varchar('attempt_id', { length: 32 }),

  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts|attemptId}.{aac|mp3|pcm}（永久保留）。失败时对象会删，但这里仍记 key 留痕 */
  audioKey: varchar('audio_key', { length: 255 }),

  /**
   * ⭐ 客户端给的**带签名下载地址**（wx.cloud.getTempFileURL 拿到的）。
   *
   * ⚠️ 为什么它必须落库、而不是像原来那样只在请求里传一次：
   *    打分现在是**异步**的 —— 受理请求立刻返回 submissionId，真正的评测在后台跑。
   *    服务端自己读对象存储要靠「开放接口服务」取临时密钥，而该服务在本项目
   *    dev 环境实测**始终没有旁加载到实例**（详见 services/audio-key.ts）。
   *    不把地址存下来，后台任务就只能走那条走不通的路。
   *
   * ⚠️ 签名地址会过期。所以读音频的顺序是「先试存下来的地址，失败再退回对象存储」，
   *    两条都不行才算 failed —— 见 services/scoring.ts。
   * ⚠️⚠️ 它指向的是**上传时那个原件**，而存档之后原件就被删了 ——
   *    所以存档那一步会把它置空（见 services/recording.ts 的 archiveRecording）。
   */
  audioUrl: varchar('audio_url', { length: 1024 }),
  /** 音频元信息 —— 音频永久保存，但库里得知道它多大、多长，否则排查「读不出来」会很瞎 */
  audioBytes: int('audio_bytes'),
  audioDurationMs: int('audio_duration_ms'),

  /**
   * ⭐ 这次录音是否**公开**（卡片之外的入口能不能听）。
   * ⚠️ 与「有没有上榜」是两回事 —— 成绩永远进榜，这只是**音频**的可见性。
   * ⚠️ 默认 false：公开必须是用户自己打开开关的结果。
   *    从挑战详情分享卡片进来的任何人本来就能听（链接即凭据），不受这一位影响。
   */
  isPublic: boolean('is_public').notNull().default(false),

  /**
   * ⭐ 这次提交**继承自 articles.theme** 的视觉主题**快照**。
   *
   * ⚠️ 为什么留快照而不是每次 join 回 articles：主题是**内容**，
   *    内容改版后应该只影响之后的新卡；历史成绩卡片要保留当时的样子。
   * ⚠️ 可空：老提交没有主题，端侧退回默认配色。
   */
  theme: json('theme').$type<ArticleTheme>(),

  /** ① 点赞数（冗余计数 —— 要能排序，每次 COUNT 会随点赞变多而变慢） */
  likeCount: int('like_count').notNull().default(0),

  /** 词级分数（JSON，随讯飞结果一次性写入） */
  wordScores: text('word_scores'),
  /**
   * 句级四维得分（JSON）：准确度 / 流利度 / 标准度 / 完整度。
   *
   * ⚠️ 单独一列、不塞进 wordScores：两者粒度不同（句级 vs 词级）。
   *    ⚠️ 更要紧的是**幂等重放**：同一段音频重试时会走 replay 分支，
   *       那一支是从库里读的 —— 不落库的话用户会看到「重试一次维度就没了」。
   */
  dimensions: text('dimensions'),

  /**
   * ⭐ 这次打分给 streak 带来的具体变化（StreakDelta 的 JSON）。
   *
   * ⚠️ 为什么必须落库：打分是异步的，结果由**轮询**取回，
   *    而轮询可能发生很多次。「+1 / 断档归 1」只在**结算那一刻**算得出来，
   *    不存下来的话，结果页就只剩一个光秃秃的天数。
   *    ⚠️ 解冻卡**不在这个快照里** —— 它有有效期，是现算的（见 services/unfreeze.ts）。
   */
  streakDelta: text('streak_delta'),

  // ----------------------------------------------------------------
  // ⭐ 成长值快照 —— 本次提交在三个指标上各拿了多少
  //
  // ⚠️⚠️ 为什么必须落库，不能回看时现算：
  //    这三个数依赖「提交那一刻的历史」（我在这句的最高分、个人最高分、榜单中位数），
  //    而历史会变 —— 现算的话同一个成绩今天显示 +5、明天显示 +3，用户会认为是 bug。
  //    落库之后是**永久冻结的事实**，与 streakDelta 同一类东西。
  //
  // ⚠️ 这里存的是「算出来是多少」，不是「真相的副本」—— 不违反「不建第二份真相」。
  // ----------------------------------------------------------------
  /** 本次自我超越（n1 与 n2 取平均后的值） */
  growthSelf: int('growth_self'),
  /** 本次坚持不懈（跨过的里程碑之和，通常是 0） */
  growthDiligence: int('growth_diligence'),
  /** 本次人中翘楚 */
  growthStandout: int('growth_standout'),
  /**
   * 本次成长值的**记账依据**（JSON）：
   * { highestInSentence, highestInUser, n1, n2, sampleSize, baseline, weight }
   * ⚠️ 回看结果页要能回答「为什么是这些分」—— 光有结果没有依据，那句话就说不出来。
   */
  growthMeta: text('growth_meta'),

  /**
   * ⭐ 这次挑战的能量状态 —— 两阶段的第二段。
   *
   *   held     = 受理时已锁住 2 点，还没结算（打分中）
   *   charged  = 打分成功，锁变成实扣
   *   released = 失败/超时，锁已退回
   *
   * ⚠️ 为什么要落这一列而不是「看 status 推」：失败与超时是**两条路**
   *    （超时那条由回收任务处理），不记下来的话回收任务不知道哪些锁还没结。
   */
  energyState: varchar('energy_state', { length: 16 }),

  /** 评测引擎标识（mock / xfyun） */
  engine: varchar('engine', { length: 16 }),
  failReason: varchar('fail_reason', { length: 255 }),

  /**
   * ⭐ AI 教练的两样输出（见 services/coach.ts）。
   *
   * ⚠️ 为什么落库：它们要跟着这条成绩一起被反复读取（结果页、榜单、回看），
   *    每次现算等于每次都调一次大模型 —— 那是不必要的钱。
   * ⚠️ 允许为空：没配 LLM_API_KEY、或模型超时/返回不合法时就是空，
   *    前端据此**整块不渲染**（而不是显示一个空框）。
   */
  aiComment: varchar('ai_comment', { length: 32 }),
  aiAdvice: text('ai_advice'),

  /**
   * ⭐ 我们自己那套打分的**分项明细**（JSON：五个分项 + 触发过的门槛）。
   *
   * ⚠️ 为什么必须落库、不能现算：
   *    结果页要显示「你这分是怎么来的」，而现算需要 `syllableErrorRate` 这类
   *    只在打分那一刻存在的中间量（引擎的返回早就不在了）。
   *    存下来还有一个好处：**分的口径改了以后，老成绩的口径不会跟着变** ——
   *    榜单上同一个分数，不能今天和明天的解释不一样。
   */
  scoreParts: text('score_parts'),

  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  scoredAt: datetime('scored_at', { mode: 'date', fsp: 3 }),
}, (t) => [
  uniqueIndex('submissions_user_article_seq_idx').on(t.userId, t.articleId, t.seq),
  /**
   * ⭐ 幂等 + 防刷：一次录音只能产生一条提交。
   *    没有它的话：网络重试会多插一条重复记录（还白扣一次冷却），
   *    并发重试会撞 seq 唯一键直接 500；
   *    而且同一段好录音可以被反复提交刷分。
   */
  uniqueIndex('submissions_user_audio_idx').on(t.userId, t.audioKey),
  /**
   * ⭐⭐ 真正的幂等键（见 attemptId 的说明）。
   * ⚠️ 与 audioKey 那个索引并存：audioKey 挡的是"同一次上传被并发提交两次"，
   *    这个挡的是"同一次录音被用户重试"——后者才是真实发生过的那条路径。
   */
  uniqueIndex('submissions_user_attempt_idx').on(t.userId, t.attemptId),
  index('submissions_user_time_idx').on(t.userId, t.createdAt),
  /**
   * ⭐ **按句子的聚合仍然要它** —— 读者是「参与记录的生产者」和「成长值快照」，
   *    不再是榜单（榜单 2026-09 起读 participations，见下面那张表）：
   *      · services/participations.ts：算某个 (user, article) 的最高分/最低分/首末时间；
   *      · growth.ts 的 arenaSnapshot：算这一句所有参与者的最高分（取中位数用）——
   *        它 WHERE article_id = ? AND status = scored 再 GROUP BY user_id。
   *
   * ⚠️⚠️ 这里原来挂的是 (schedule_date, score)，注释写着
   *    「每日挑战的统计与排行全部走这条索引」—— 那是**按天口径**时代留下的，
   *    现在是**死索引**：全仓库没有任何查询按 schedule_date 过滤或排序
   *    （那一列只用于显示「这次是从哪天的排期进来的」，见上面的注释）。
   *    ⇒ 换成按句子的索引（迁移 0037）。
   *
   * ⚠️ 列序 (article_id, status, user_id, score)：前两列圈定这一句的已出分提交，
   *    后两列让「按人取 MAX(score)」能**只走索引**。
   *    ⚠️ createdAt 故意不放进索引（只有「等于最高分」的那些行要看它），
   *       塞进来会让索引变宽而收益很小。
   */
  index('submissions_article_idx').on(t.articleId, t.status, t.userId, t.score),
])


/**
 * ⭐⭐ **参与记录** —— 一个人在**一个竞技场（句子）**里的那一次参与。
 *
 *    层级关系（用户 2026-09 定的，别混）：
 *      · 竞技场（一篇正文）  ⊃  参与记录（一人一行）  ⊃  挑战记录（= submissions，一次录音一行）
 *      · 「我的参与」= 我在这一句上的那个**身份**；每次挑战都更新它，但它只有一条。
 *      · **对比标准 = 我的最高分挑战**（bestSubmissionId）—— 榜单比的是参与，
 *        而参与拿什么去比，由它指向的那条挑战决定（并列时取先达到该分的那条，
 *        与 services/leaderboard.ts 的三键全序完全同源）。
 *
 * ⚠️⚠️ **它是派生索引，不是第二份真相** —— 与 articles.difficulty 同一类：
 *    · 真相永远在 submissions；这里的每一列都是 submissions 的函数；
 *    · **唯一写入方**是 services/participations.ts 的 syncParticipation（重算式，幂等）；
 *    · 随时可以整表重建（rebuildParticipations），重建前后必须一模一样 ——
 *      这是验收判据，也是它和 0034 删掉的那两列（participant_count / conquered_count）的区别：
 *      那两列是只写不读的计数副本，而且有两个写入方；这一张有明确的读者（榜单 / 参与场次 / 攻克数）。
 *
 * ⚠️ 口径与 conquest 一致：**只算 status = scored 的挑战** ——
 *    「音频读不出来 / 引擎判无效」那几次不算参与（否则会出现「你已挑战 3 次」却只有一条成绩）。
 */
export const participations = mysqlTable('participations', {
  userId: int('user_id').notNull().references(() => users.id),
  articleId: varchar('article_id', { length: ARTICLE_ID_LENGTH }).notNull().references(() => articles.id),

  /** 已出分的挑战次数（与参与人数同一口径） */
  attempts: int('attempts').notNull(),
  /** 我在这一句上的最高分 —— **进榜的那个数** */
  bestScore: decimal('best_score', { precision: 5, scale: 1 }).notNull(),
  /** 最低分（参与场次列表展示用） */
  worstScore: decimal('worst_score', { precision: 5, scale: 1 }).notNull(),
  /** 第一次 / 最近一次已出分挑战的时刻（列表按 last_at 倒序） */
  firstAt: datetime('first_at', { mode: 'date', fsp: 3 }).notNull(),
  lastAt: datetime('last_at', { mode: 'date', fsp: 3 }).notNull(),
  /** 最近那次挑战是从哪一天的排期进来的（显示用；竞技术语里没有它） */
  lastScheduleDate: varchar('last_schedule_date', { length: 10 }),

  /**
   * ⭐ **对比标准**：我的最高分挑战。
   * ⚠️ 并列时取**先达到该分数**的那条 —— 榜单的同分先后就是按它排的。
   */
  bestSubmissionId: varchar('best_submission_id', { length: SUBMISSION_ID_LENGTH })
    .notNull()
    .references(() => submissions.id),
  /**
   * 首次达到 bestScore 的时刻（= bestSubmission 的 created_at）。
   * ⚠️ 冗余这一列是为了让它**能直接排序** —— 榜单的主查询因此不再需要 GROUP BY / join。
   *    不变量：reachedAt 必须等于 bestSubmissionId 那一条的 created_at（重建会保证）。
   */
  reachedAt: datetime('reached_at', { mode: 'date', fsp: 3 }).notNull(),
}, (t) => [
  /** ⭐ 一人一场一行 —— 这条主键就是「参与记录」的定义 */
  primaryKey({ columns: [t.userId, t.articleId] }),
  /**
   * ⭐⭐ 榜单的主查询：按句子取全部参与，按**对比标准**排序。
   *    列序与 orderBy 一致（best_score desc, reached_at asc, user_id asc）——
   *    连「同分同刻再比 id」的兜底键都在里面，所以它同时是排序索引。
   */
  index('participations_arena_idx').on(t.articleId, t.bestScore, t.reachedAt, t.userId),
  /** 「我参与过哪些句子」——按最近参与倒序 */
  index('participations_user_time_idx').on(t.userId, t.lastAt),
])

/** 订阅记录 */
export const subscriptions = mysqlTable('subscriptions', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  /** monthly | yearly */
  plan: varchar('plan', { length: 16 }).notNull(),
  /** active | expired | canceled */
  status: varchar('status', { length: 16 }).notNull(),
  /** payment | gift | promo —— 订阅可以不来自支付 */
  source: varchar('source', { length: 16 }).notNull().default('payment'),
  /** ⭐ 可空：赠送/活动的订阅没有支付，但付费订阅要能追溯到那笔钱 */
  paymentId: int('payment_id').references(() => payments.id),
  startAt: datetime('start_at', { mode: 'date', fsp: 3 }).notNull(),
  endAt: datetime('end_at', { mode: 'date', fsp: 3 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [index('subscriptions_user_idx').on(t.userId, t.endAt)])

/**
 * ⭐ 商品目录（**可配置** —— 改价不用发版）。
 *
 * ⚠️ 为什么落库而不是写死在代码里：价格必须**和小程序里显示的一致**，
 *    而小程序审核要 1–3 天 —— 把价格绑在发版上，促销/调价就废了。
 *    与 reward_rules 是同一个判断：**能被运营改的东西不要写死在代码里**。
 *
 * ⚠️ 但**下单时必须快照**（见 payments 的 goods_code / goods_amount）：
 *    商品以后改了，历史订单必须还是当时那个商品 —— 改配置不追溯。
 *
 * ⚠️⚠️ price_fen 必须与**微信侧「道具管理」里的价格一致**：
 *    道具价格安卓 / iOS 双端通用，且发货推送会带 ActualPrice 供对账。
 *
 * ⚠️ 首档不能低于 ¥1.00（iOS 最低支付金额）—— 不变量由 shared 的单元测试守着。
 */
export const goods = mysqlTable('goods', {
  /** 商品码：energy_10 / energy_300 / energy_3000 …（下单时用它，不用自增 id） */
  code: varchar('code', { length: 32 }).notNull().primaryKey(),
  /** energy | unfreeze —— 决定发货加到哪儿（见 shared 的 GOODS_KIND） */
  kind: varchar('kind', { length: 16 }).notNull(),
  /** 发多少（点 / 张） */
  amount: int('amount').notNull(),
  /** 售价，单位**分**（2000 = ¥20.00）。⚠️ 必须是整元（微信道具只收整数元） */
  priceFen: int('price_fen').notNull(),
  /**
   * ⭐ 微信侧「道具管理」里的**道具 ID**。
   * ⚠️ 可空：开通虚拟支付、建好道具之前是空的（那时只有 mock 通道能下单）。
   */
  xpayProductId: varchar('xpay_product_id', { length: 64 }),
  title: varchar('title', { length: 32 }).notNull(),
  subtitle: varchar('subtitle', { length: 64 }).notNull().default(''),
  /** 角标文案（如「最划算」），可空 */
  badge: varchar('badge', { length: 16 }),
  sort: int('sort').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

/** 支付（财务凭证，独立于订阅） */
export const payments = mysqlTable('payments', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  /** 微信支付商户单号（**我们自己生成**的，也是发货的幂等键） */
  outTradeNo: varchar('out_trade_no', { length: 64 }).notNull().unique(),
  /**
   * ⭐ 商品码 —— **下单那一刻的快照**。
   * ⚠️ 它占的是原来 plan 列的位置（monthly | yearly，旧包月模型的遗留）——
   *    那一列在 0020 里删掉了。分两步走是因为 drizzle-kit 对「同时删一列加一列」
   *    会弹交互式 rename 提问，非 TTY 环境答不了。
   * ⚠️ 这一列占的是原来 plan 的位置（monthly | yearly，旧包月模型的遗留）。
   * ⚠️ 不 join goods 表：商品以后改价改名，历史订单必须还是当时那个商品。
   */
  goodsCode: varchar('goods_code', { length: 32 }).notNull().default(''),
  /** 商品种类快照（energy | unfreeze）—— 发货时按它分支 */
  goodsKind: varchar('goods_kind', { length: 16 }).notNull().default(''),
  /** 发多少点/张的快照 */
  goodsAmount: int('goods_amount').notNull().default(0),
  /** 金额，单位分（¥20 → 2000）。⚠️ 必须与微信侧道具价格一致，发货时对账 */
  amount: int('amount').notNull(),
  /** pending | paid | refunded | failed */
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  /** 微信支付预支付会话 id —— 查单 / 关单要用 */
  prepayId: varchar('prepay_id', { length: 64 }),
  /**
   * ⭐ 虚拟支付平台返回的单号（文档里的 wx_order_id）。
   * ⚠️ 和 out_trade_no（我们自己生成的）是两个东西：查单、对账、退款都用它。
   */
  xpayOrderId: varchar('xpay_order_id', { length: 64 }),
  /** 支付环境：0 = 现网，1 = 沙箱。⚠️ 同一个单号在两边是两个世界 */
  payEnv: int('pay_env').notNull().default(0),
  /**
   * ⚠️ 微信支付订单号，**和 out_trade_no 是两个东西**。
   *    对账、退款全靠它；out_trade_no 是我们自己生成的商户单号。
   */
  transactionId: varchar('transaction_id', { length: 64 }),
  paidAt: datetime('paid_at', { mode: 'date', fsp: 3 }),
  /**
   * ⭐ 发货时间。
   * ⚠️ paid 是「钱到了」，delivered 是「货发了」—— 两件事，不合成一个：
   *    钱到了但发货失败（我们写库挂了）是**必须能被发现**的状态。
   * ⚠️ 发货有两条路（平台推送、主动查单），两条都要幂等地写这一个时间戳。
   */
  deliveredAt: datetime('delivered_at', { mode: 'date', fsp: 3 }),

  /** 退款是**独立的单**，不是把 status 改成 refunded 就完事 */
  refundNo: varchar('refund_no', { length: 64 }),
  refundAmount: int('refund_amount'),
  refundedAt: datetime('refunded_at', { mode: 'date', fsp: 3 }),

  /** ⭐ 支付回调原文 —— 对账出问题时这是唯一的救命稻草 */
  rawNotify: text('raw_notify'),

  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  // 微信订单号唯一（未支付时为 NULL，MySQL 的 UNIQUE 允许多个 NULL）
  uniqueIndex('payments_transaction_idx').on(t.transactionId),
  index('payments_user_time_idx').on(t.userId, t.createdAt),
])

/**
 * ⭐⭐ **收藏 —— 用户收藏了一个句子**（不是某一次提交）。
 *
 * ⚠️ 与 likes 的区别别混：likes 赞的是**一次挑战**（submission），
 *    收藏收的是**这个竞技场 / 这句话本身** —— 用户想「以后还能找到它」，
 *    与谁读得好、读了几次无关。
 *
 * ⚠️ 主键就是 (user_id, article_id)：收一次就够了，重复点不会产生第二行
 *    （收藏是**幂等**的开关，不是流水）。
 * ⚠️ 句子下架（isActive=false）**不清收藏**：收藏是用户的东西，
 *    句子还在（arena 路由也不校验 isActive），列表里照常看得到。
 */
export const favorites = mysqlTable('favorites', {
  userId: int('user_id').notNull().references(() => users.id),
  articleId: varchar('article_id', { length: ARTICLE_ID_LENGTH }).notNull().references(() => articles.id),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  /** ⭐ 一人一句一行 —— 收藏是个开关 */
  primaryKey({ columns: [t.userId, t.articleId] }),
  /** 「我的收藏」列表：按收藏时间倒序（最近收的排前面） */
  index('favorites_user_time_idx').on(t.userId, t.createdAt),
])

/** 点赞 —— 谁赞了哪条 submission */
export const likes = mysqlTable('likes', {
  id: int('id').autoincrement().primaryKey(),
  submissionId: varchar('submission_id', { length: SUBMISSION_ID_LENGTH }).notNull().references(() => submissions.id),
  userId: int('user_id').notNull().references(() => users.id),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  uniqueIndex('likes_submission_user_idx').on(t.submissionId, t.userId),
  index('likes_submission_idx').on(t.submissionId),
])

/** LLM 对某次提交的反馈 */
export const reviews = mysqlTable('reviews', {
  id: int('id').autoincrement().primaryKey(),
  submissionId: varchar('submission_id', { length: SUBMISSION_ID_LENGTH }).notNull().references(() => submissions.id),
  /**
   * ⚠️ 可空 —— LLM 反馈是异步的，pending 时还没有正文。
   *    参考文本也在这里：reviews 只是「对某次提交的反馈」，与讯飞的分无关。
   */
  content: text('content'),
  /** 哪个模型 / 版本 */
  model: varchar('model', { length: 32 }),

  /** pending | done | failed —— 调模型会失败、要重试，必须有状态机 */
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  attempts: int('attempts').notNull().default(0),
  error: varchar('error', { length: 255 }),

  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  index('reviews_submission_idx').on(t.submissionId),
  // 异步 worker 靠这条捞「待处理」
  index('reviews_status_idx').on(t.status, t.createdAt),
])


/* ================================================================== */
/* ⭐ 解冻卡 / 奖励 / 能量流水                                           */
/*    规格：docs/design/reward-system.md 与 docs/design/growth-and-energy.md */
/* ================================================================== */

/**
 * ⭐ 解冻卡 —— **一张卡一行**。
 *
 * ⚠️⚠️ 为什么不是 users 上的一个计数器：
 *    ① 卡有**有效期**，「手上还有几张」要按 expires_at 过滤，整数表达不了；
 *    ② 需要**使用记录**（用户主动用的，什么时候补的哪一次断档，必须能查）。
 *
 * ⚠️ 「过期」**不落状态**，由 expires_at 与「现在」比较得出 ——
 *    落一个 expired 状态就需要定时任务去翻，那是白给自己找事。
 */
export const unfreezeCards = mysqlTable('unfreeze_cards', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  grantedAt: datetime('granted_at', { mode: 'date', fsp: 3 }).notNull(),
  /**
   * ⭐ **领取时间；null = 待领取**。
   *
   * ⚠️⚠️ 奖励发下来**不等于**进了用户的口袋 —— 待领取是刻意的：
   *    用户得回到「连战记录」页点一下才真正拿到。
   *    （这也是那一页存在的理由之一：它得有点"值得回来一趟"的东西。）
   * ⚠️ 所以「手上还有几张」的判据是**三条一起**：
   *    claimed_at IS NOT NULL AND used_at IS NULL AND expires_at > now。
   */
  claimedAt: datetime('claimed_at', { mode: 'date', fsp: 3 }),
  /**
   * 到期时间 —— ⚠️ **可空，因为领取时才定**（claimedAt + 1 年）。
   *
   * ⚠️ 为什么不在发放时就定时：那样"没及时来领"会变成"白白过期"，
   *    而用户根本没机会知道 —— 同一个页面里既催他回来、又偷偷扣他的东西，
   *    这件事说不通。领取之后才开始倒计时。
   * ⚠️ 消耗时仍然**先到期先用**（FIFO by expires_at）。
   */
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
  /** null = 还在手上；非 null = 已用（状态就靠它判断，见上） */
  usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
  /** 使用记录：补的是几天断档（今天 − lastReadDate − 1） */
  usedForGap: int('used_for_gap'),
  /** 哪条规则发的（可追溯到规则；规则后来改了也不影响这张卡） */
  ruleCode: varchar('rule_code', { length: 64 }),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  // 「我手上还有几张、最早哪张到期」就是这一个查询
  index('unfreeze_cards_user_idx').on(t.userId, t.expiresAt),
])

/**
 * ⭐ 奖励规则 —— **可配置**，于是运营改阈值不用发版。
 *
 * ⚠️ trigger 是**封闭枚举**（streak_milestone / sentence_top_exceed / daily_topup），
 *    不是自由表达式。加新触发点要发版，但不改求值器 ——
 *    自由表达式引擎没法测、也没法向用户解释，而「弹性可配置」要的是
 *    **阈值和数量**可配，不是**逻辑**可配。
 *
 * ⚠️ 改配置**不追溯**：规则只对 starts_at 之后的事件生效。
 *    改配置 = 停旧规则 + 起新规则（这也是「必须落库」的根本原因）。
 */
export const rewardRules = mysqlTable('reward_rules', {
  id: int('id').autoincrement().primaryKey(),
  /** 规则标识，唯一。grantReward 的幂等键里有它 */
  code: varchar('code', { length: 64 }).notNull().unique(),
  trigger: varchar('trigger', { length: 32 }).notNull(),
  /** 结构化参数（阈值 / N 等），JSON */
  params: text('params'),
  /** unfreeze | energy */
  rewardKind: varchar('reward_kind', { length: 16 }).notNull(),
  rewardAmount: int('reward_amount').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** 生效时间 —— 只对之后的事件生效（不追溯） */
  startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }),
  /** 上限：防正反馈失控（奖励发能量 ⇒ 多读 ⇒ 更多提交 ⇒ 更多奖励） */
  dailyCap: int('daily_cap'),
  lifetimeCap: int('lifetime_cap'),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

/**
 * ⭐ 奖励发放流水 —— **幂等键就在这里**。
 *
 * ⚠️⚠️ unique(rule_code, ref_type, ref_id, user_id) 是整套奖励系统的安全底：
 *    重放、补跑、并发、改配置，全靠它兜底。没有它，同一次挑战会被发好几次。
 *
 * ⚠️ ref_id 用 **submission_id**，不是 article_id：
 *    规则 B 是「每次破纪录都发」，用 article_id 做键会导致一个人在同一句上
 *    一辈子只发一次。
 *
 * ⚠️ reward_kind / reward_amount 存的是**快照** —— 规则后来改了，
 *    历史发放记录也不该跟着变。
 */
export const rewardGrants = mysqlTable('reward_grants', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  ruleCode: varchar('rule_code', { length: 64 }).notNull(),
  /** submission | day | purchase */
  refType: varchar('ref_type', { length: 16 }).notNull(),
  refId: varchar('ref_id', { length: 64 }).notNull(),
  rewardKind: varchar('reward_kind', { length: 16 }).notNull(),
  rewardAmount: int('reward_amount').notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  uniqueIndex('reward_grants_idem_idx').on(t.ruleCode, t.refType, t.refId, t.userId),
  index('reward_grants_user_idx').on(t.userId, t.createdAt),
])

/**
 * ⭐ 能量流水 —— **流水是真相，users.energy 是缓存**。
 *
 * ⚠️⚠️ 两者必须**在同一个事务里**写。分开写就一定会漂移，
 *    而「余额和流水对不上」是最难查的一类问题（没有任何东西看起来是坏的）。
 *
 * reason 取值：daily_topup / purchase / challenge_hold / challenge_release / admin /
 * 以及奖励规则的 code。
 *
 * ⚠️ unique(reason, ref_type, ref_id, user_id) 是**一次性发放**的幂等键：
 *    同一条 submission 的 hold 只会有一行、同一天的 topup 只会有一行。
 *    （hold 与 release 的 reason 不同，所以不会互相撞。）
 */
export const energyLedger = mysqlTable('energy_ledger', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  /** 正数入账、负数出账，单位「点」 */
  delta: int('delta').notNull(),
  reason: varchar('reason', { length: 64 }).notNull(),
  /** submission | day | purchase | reward */
  refType: varchar('ref_type', { length: 16 }).notNull(),
  refId: varchar('ref_id', { length: 64 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  uniqueIndex('energy_ledger_idem_idx').on(t.reason, t.refType, t.refId, t.userId),
  index('energy_ledger_user_idx').on(t.userId, t.createdAt),
])

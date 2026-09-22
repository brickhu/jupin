import { sql } from 'drizzle-orm'
import {
  mysqlTable, int, varchar, boolean, datetime, decimal, text, index, uniqueIndex,
} from 'drizzle-orm/mysql-core'

/**
 * 数据模型（与用户对齐后的最终版）。
 *
 * ⭐ 命名原则：**「竞技场」是抽象概念，不落到表名上**。
 *    朗读单元直接叫 articles；提交记录叫 submissions。
 *
 * ⭐ 内容不入库：articles 只是**索引**——正文 / 技巧 / 标准音都是静态资源引用，
 *    库里只留「能被索引和排序」的字段（排期 / 竞技统计）。
 *
 * ⚠️ 难度、分类已经**整体下线**（做减法后的产品只有三条核心：得分 / 排名 / Streak）。
 *    历史迁移 0003 / 0004 里能看到它们的删除过程，别再按老文档把它们加回来。
 *
 * ⚠️ MySQL 的 DATETIME 不存时区 —— 全链路按 UTC 读写（见 db/index.ts 的 timezone 设置）。
 */

export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  openid: varchar('openid', { length: 64 }).notNull().unique(),
  unionid: varchar('unionid', { length: 64 }),
  nickname: varchar('nickname', { length: 64 }),
  avatarUrl: varchar('avatar_url', { length: 512 }),

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
   * ⚠️ **孜孜不倦用的是 streakDays 的跨档，不是它** —— 跨档是事件，只发生一次；
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
  /** 孜孜不倦（跨过 7 / 30 / 180 / 360×k 里程碑） */
  growthDiligence: int('growth_diligence').notNull().default(0),
  /** 鹤立鸡群（与榜单中位数的差距 × 样本量权重） */
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

  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

/** 朗读单元（文章 = 句子）。内容走静态资源，这里只放索引与竞技状态/统计 */
export const articles = mysqlTable('articles', {
  /** 由内容流水线分配，稳定不变 */
  id: int('id').primaryKey(),
  /** 正文静态 JSON 地址（句子原文 + 词级数据 + 句群切分） */
  contentJson: varchar('content_json', { length: 512 }).notNull(),
  /** 朗读技巧 JSON 地址 */
  tipsJson: varchar('tips_json', { length: 512 }),
  /** 标准发音 MP3 地址 */
  standardAudio: varchar('standard_audio', { length: 512 }),
  /**
   * 内容发布状态：draft | published | archived。
   * ⚠️ 与 is_active（竞技开关）是两回事：内容是先发布、再决定开不开竞技。
   */
  contentStatus: varchar('content_status', { length: 16 }).notNull().default('draft'),
  /** 内容指纹 —— 流水线重跑时判断要不要重新发布 */
  contentHash: varchar('content_hash', { length: 64 }),

  /** 竞技状态：是否开放 */
  isActive: boolean('is_active').notNull().default(true),
  /** 参与人数（冗余计数，可排序） */
  participantCount: int('participant_count').notNull().default(0),
  /** 攻克人数 —— 在这条句子上**拿到过分数**的去重用户数（85 分线已废除） */
  conqueredCount: int('conquered_count').notNull().default(0),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

/**
 * ⭐⭐ 每日排期 —— 「哪一天展示哪一句」。
 *
 * ⚠️⚠️ **它不是竞技单位，只是一个按日组织的展示层 / 推荐层。**
 *
 *    竞技数据的单位永远是**句子**（见 services/leaderboard.ts）：
 *    排名、参与人数、最高分、我的最好成绩，全部按 article_id 查。
 *    这一张表只回答「今天首页上该出现哪一句」，答完就没它的事了。
 *
 *    ⚠️ 所以它**不能叫 challenges**。叫 challenges 会让人以为
 *       「某一天的挑战」是个带成绩、带名次的东西 —— 于是统计很自然就会
 *       被挂到日期上，而这个产品里那件事从来没有成立过。
 *       名字会引导实现，起错了名字，错的就是设计。
 *
 * ⚠️⚠️ 为什么它必须和 articles 分开，而不是在句子上挂一个 publish_date：
 *
 *   ① **句子是可复用的内容，挑战是一次排期。** 两者是不同生命周期的东西：
 *      句子会被反复读到（池子只有几句，按天轮转），
 *      排期则是「2026-11-24 这天用哪一句」这一次决定。
 *      把日期写在句子上，等于让内容本身携带了一个只能有一次的排期 ——
 *      公开库里 publish_date 上加 UNIQUE 就是这个矛盾的直接证据：
 *      同一句排第二次就会撞唯一键。
 *
 *   ② **统计和排行是按天算的**（参与人数、最高分、我的名次）。
 *      没有这张表，「某一天的挑战」在数据上根本不成为一个实体，
 *      只能靠「拿天号对池子取模」在每次查询时现算 ——
 *      而池子一旦增删句子，**历史那几天的题目会一起变**，
 *      昨天读过的句子今天就变成另一句了。
 *      落成行之后，历史是钉死的。
 *
 *   ③ 将来要给挑战加东西（运营标题、是否开放、结束时间），
 *      有地方可加，不用往句子上堆。
 *
 * ⚠️ 没有排期的日子**按天号轮转自动补一行**（source='rotation'），
 *    所以「今天没题」这件事在数据上不可能发生。
 */
export const schedules = mysqlTable('schedules', {
  /** 展期 'YYYY-MM-DD'（北京时间）—— 一天一条，所以直接做主键 */
  date: varchar('date', { length: 10 }).primaryKey(),
  /** 那天展示哪一句 */
  articleId: int('article_id').notNull().references(() => articles.id),
  /**
   * scheduled = 运营明确排的；rotation = 按天号自动轮的。
   * ⚠️ 存下来是为了**能区分**：运营漏排和自动补上，排查时要一眼看出来。
   */
  source: varchar('source', { length: 16 }).notNull().default('rotation'),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  // 「这个句子被排在哪些天」—— 排期去重、内容下线前的引用检查都要走它
  index('schedules_article_idx').on(t.articleId),
])

/** 标签关联表 —— 独立成表才能按单个标签索引 */
export const articleTags = mysqlTable('article_tags', {
  articleId: int('article_id').notNull().references(() => articles.id),
  tag: varchar('tag', { length: 32 }).notNull(),
}, (t) => [
  uniqueIndex('article_tags_uniq_idx').on(t.articleId, t.tag),
  index('article_tags_tag_idx').on(t.tag),
])

/** 提交记录 —— 每次一条，永久保留 */
export const submissions = mysqlTable('submissions', {
  /** hash(userId, articleId, seq)，由服务端算（services/audio-key.ts） */
  id: varchar('id', { length: 40 }).primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  articleId: int('article_id').notNull().references(() => articles.id),
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
   * 这条提交算不算「攻克」—— **拿到分数就算**（85 分线已废除，见 services/conquest.ts）。
   * ⚠️ 这一列现在是 status = 'scored' 的同义词，保留只为留痕；
   *    统计一律以 status 为准 —— 老数据这一列是按旧线写的，会漏。
   */
  isConquered: boolean('is_conquered'),

  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts}.{aac|mp3|pcm}（永久保留）。失败时对象会删，但这里仍记 key 留痕 */
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
   * ⭐ 这次录音是否**公开**（别人能不能听）。
   * ⚠️ 与「有没有上榜」是两回事 —— 成绩永远进榜，这只是**音频**的可见性。
   *    默认 true：不设隐私开关的产品，用户的声音会在不知情的情况下被听见。
   */
  isPublic: boolean('is_public').notNull().default(true),

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
  /** 本次孜孜不倦（跨过的里程碑之和，通常是 0） */
  growthDiligence: int('growth_diligence'),
  /** 本次鹤立鸡群 */
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
  index('submissions_user_time_idx').on(t.userId, t.createdAt),
  /**
   * ⭐ 每日挑战的统计与排行全部走这条索引。
   *    ⚠️ 顺序是 (schedule_date, score)：先按天圈定一批，再在批内按分排序 ——
   *       正好是「今天谁最高分」这一个查询。
   */
  index('submissions_schedule_idx').on(t.scheduleDate, t.score),
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

/** 支付（财务凭证，独立于订阅） */
export const payments = mysqlTable('payments', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  /** 微信支付商户单号 */
  outTradeNo: varchar('out_trade_no', { length: 64 }).notNull().unique(),
  /** monthly | yearly */
  plan: varchar('plan', { length: 16 }).notNull(),
  /** 金额，单位分（19.9 → 1990） */
  amount: int('amount').notNull(),
  /** pending | paid | refunded | failed */
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  /** 微信支付预支付会话 id —— 查单 / 关单要用 */
  prepayId: varchar('prepay_id', { length: 64 }),
  /**
   * ⚠️ 微信支付订单号，**和 out_trade_no 是两个东西**。
   *    对账、退款全靠它；out_trade_no 是我们自己生成的商户单号。
   */
  transactionId: varchar('transaction_id', { length: 64 }),
  paidAt: datetime('paid_at', { mode: 'date', fsp: 3 }),

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

/** 点赞 —— 谁赞了哪条 submission */
export const likes = mysqlTable('likes', {
  id: int('id').autoincrement().primaryKey(),
  submissionId: varchar('submission_id', { length: 40 }).notNull().references(() => submissions.id),
  userId: int('user_id').notNull().references(() => users.id),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => [
  uniqueIndex('likes_submission_user_idx').on(t.submissionId, t.userId),
  index('likes_submission_idx').on(t.submissionId),
])

/** LLM 对某次提交的反馈 */
export const reviews = mysqlTable('reviews', {
  id: int('id').autoincrement().primaryKey(),
  submissionId: varchar('submission_id', { length: 40 }).notNull().references(() => submissions.id),
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
  /** 到期时间 = grantedAt + 1 年。⚠️ 消耗时**先到期先用**（FIFO by expires_at） */
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
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

import { sql } from 'drizzle-orm'
import {
  mysqlTable, int, varchar, boolean, datetime, text, index, uniqueIndex,
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

  /** ⭐ 滚动冷却：下次可免费提交（= 上次提交 + 24h，不是自然日重置） */
  nextFreeAt: datetime('next_free_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),

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
  /** 历史最长连续天数 —— **只增不减**，等级徽章的唯一依据（徽章由它推导，不落库） */
  streakBest: int('streak_best').notNull().default(0),
  /** 最后一次计入 streak 的自然日 'YYYY-MM-DD'（北京时间）。never read 时为 null */
  lastReadDate: varchar('last_read_date', { length: 10 }),
  /** 冻结卡：断档时自动消耗，每连续满 7 天得 1 张 */
  freezeCount: int('freeze_count').notNull().default(0),

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
  /** 征服人数（≥ CONQUEST_THRESHOLD） */
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
  /** 讯飞总分 0–100 */
  score: int('score'),
  /** score >= CONQUEST_THRESHOLD */
  isConquered: boolean('is_conquered'),

  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts}.pcm（永久保留）。失败时对象会删，但这里仍记 key 留痕 */
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
   *    而轮询可能发生很多次。「+1 / 用掉几张冻结卡 / 解锁了哪个徽章」
   *    只在 recordRead 那一刻算得出来，不存下来的话，
   *    结果页就只能显示一个光秃秃的天数 —— 用户根本不知道冻结卡干了什么。
   */
  streakDelta: text('streak_delta'),

  /** 评测引擎标识（mock / xfyun） */
  engine: varchar('engine', { length: 16 }),
  failReason: varchar('fail_reason', { length: 255 }),

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

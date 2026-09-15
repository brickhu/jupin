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
 *    库里只留「能被索引和排序」的字段（难度 / 分类 / 标签 / 竞技统计）。
 *    详见 spec.md。
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
  /** 难度 1–5 —— 可索引可排序 */
  difficulty: int('difficulty').notNull(),
  /** 分类 —— 可索引 */
  category: varchar('category', { length: 32 }).notNull(),
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
}, (t) => [
  index('articles_difficulty_idx').on(t.difficulty),
  index('articles_category_idx').on(t.category),
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

  /** scored = 检测成功（音频永久保留）；failed = 检测失败（音频已删） */
  status: varchar('status', { length: 16 }).notNull(),
  /** 讯飞总分 0–100 */
  score: int('score'),
  /** score >= CONQUEST_THRESHOLD */
  isConquered: boolean('is_conquered'),

  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts}.pcm（永久保留）。失败时对象会删，但这里仍记 key 留痕 */
  audioKey: varchar('audio_key', { length: 255 }),
  /** 音频元信息 —— 音频永久保存，但库里得知道它多大、多长，否则排查「读不出来」会很瞎 */
  audioBytes: int('audio_bytes'),
  audioDurationMs: int('audio_duration_ms'),

  /** ① 点赞数（冗余计数 —— 要能排序，每次 COUNT 会随点赞变多而变慢） */
  likeCount: int('like_count').notNull().default(0),

  /** 词级分数（JSON，随讯飞结果一次性写入） */
  wordScores: text('word_scores'),
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

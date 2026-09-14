import {
  pgTable, serial, bigint, varchar, integer, boolean, timestamp, text, index, uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * 数据模型（详见 spec.md 第八节）
 *
 * ⚠️ 内容（短文正文 / 词级数据 / 技巧）**不入库**，全部走 CDN 静态资源。
 *    库里只放：用户、成绩、榜单所需的元数据。
 */

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  openid: varchar('openid', { length: 64 }).notNull().unique(),
  unionid: varchar('unionid', { length: 64 }),
  nickname: varchar('nickname', { length: 64 }),
  avatarUrl: varchar('avatar_url', { length: 512 }),

  /** 会员到期时间；null = 非会员 */
  subscriptionEnd: timestamp('subscription_end'),

  /** ⭐ 滚动冷却：下次可免费提交的时间（= 上次提交 + 24h，不是自然日重置） */
  nextFreeAt: timestamp('next_free_at').defaultNow().notNull(),

  /** 无效提交计数（防刷） */
  invalidCount: integer('invalid_count').default(0).notNull(),
  invalidDate: varchar('invalid_date', { length: 10 }),

  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/** 竞技场元数据（正文在 CDN） */
export const arenas = pgTable('arenas', {
  id: integer('id').primaryKey(),
  passageId: integer('passage_id').notNull(),
  position: integer('position').notNull(),
  content: text('content').notNull(),
  stars: integer('stars').notNull(),
  wordCount: integer('word_count').notNull(),
  /** 预期语音时长（毫秒），供端侧预检第②层使用 */
  expectedSpeechMs: integer('expected_speech_ms').notNull(),
  /** 冗余计数，避免每次 COUNT */
  participantCount: integer('participant_count').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
}, (t) => [index('arenas_passage_idx').on(t.passageId)])

/** 成绩 */
export const arenaEntries = pgTable('arena_entries', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  arenaId: integer('arena_id').notNull().references(() => arenas.id),
  userId: integer('user_id').notNull().references(() => users.id),
  /** 云端权威分 0–100 */
  score: integer('score').notNull(),
  /** score >= CONQUEST_THRESHOLD */
  isConquered: boolean('is_conquered').default(false).notNull(),
  /** 词级结果（可选副产品，有则存） */
  words: text('words'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  // ⭐ 一条复合索引覆盖全部榜单查询
  index('entries_rank_idx').on(t.arenaId, t.score, t.createdAt),
  // 一人一场一条（取最高分）
  uniqueIndex('entries_user_arena_idx').on(t.arenaId, t.userId),
])

export const payments = pgTable('payments', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  type: varchar('type', { length: 16 }).notNull(),
  amount: integer('amount').notNull(),
  outTradeNo: varchar('out_trade_no', { length: 64 }).notNull().unique(),
  status: varchar('status', { length: 16 }).default('pending').notNull(),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

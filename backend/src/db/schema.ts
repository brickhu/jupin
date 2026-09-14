import {
  pgTable, serial, varchar, text, integer, decimal,
  boolean, jsonb, timestamp, date, bigint, pgEnum
} from 'drizzle-orm/pg-core'

// 订阅类型枚举
export const subscriptionTypeEnum = pgEnum('subscription_type', ['single', 'monthly', 'yearly'])
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'success', 'refunded', 'failed'])

// 用户表
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  nickname: varchar('nickname', { length: 64 }),
  proficiencyScore: decimal('proficiency_score', { precision: 4, scale: 1 }).default('0').notNull(),
  totalExperience: integer('total_experience').default(0).notNull(),
  honorTitle: varchar('honor_title', { length: 32 }).default('朗读者').notNull(),
  streakDays: integer('streak_days').default(0).notNull(),
  lastReadAt: timestamp('last_read_at'),
  subscriptionEnd: timestamp('subscription_end'),
  dailySubmissionsLeft: integer('daily_submissions_left').default(5).notNull(),
  dailyResetDate: date('daily_reset_date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 文章表
export const articles = pgTable('articles', {
  id: serial('id').primaryKey(),
  content: text('content').notNull(),
  translation: varchar('translation', { length: 1024 }),
  difficulty: decimal('difficulty', { precision: 2, scale: 1 }).notNull(),
  dLen: decimal('d_len', { precision: 2, scale: 1 }).default('0').notNull(),
  dVocab: decimal('d_vocab', { precision: 2, scale: 1 }).default('0').notNull(),
  dSyntax: decimal('d_syntax', { precision: 2, scale: 1 }).default('0').notNull(),
  wordCount: integer('word_count').notNull(),
  sourceType: varchar('source_type', { length: 32 }).default('quote').notNull(),
  author: varchar('author', { length: 128 }),
  publishDate: date('publish_date'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 朗读记录表
export const readings = pgTable('readings', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  articleId: integer('article_id').references(() => articles.id).notNull(),
  qualityScore: decimal('quality_score', { precision: 4, scale: 1 }).notNull(),
  experienceGained: integer('experience_gained').default(0).notNull(),
  proficiencyBefore: decimal('proficiency_before', { precision: 4, scale: 1 }),
  proficiencyAfter: decimal('proficiency_after', { precision: 4, scale: 1 }),
  isPaid: boolean('is_paid').default(false).notNull(),
  isBest: boolean('is_best').default(false).notNull(),
  errorDetail: jsonb('error_detail'),
  aiSuggestions: jsonb('ai_suggestions'),
  audioDuration: integer('audio_duration'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 发音建议缓存表
export const pronunciationTips = pgTable('pronunciation_tips', {
  id: serial('id').primaryKey(),
  word: varchar('word', { length: 64 }).notNull(),
  errorType: varchar('error_type', { length: 32 }).notNull(),
  correctPhoneme: varchar('correct_phoneme', { length: 32 }),
  userPhoneme: varchar('user_phoneme', { length: 32 }),
  tip: text('tip').notNull(),
  hitCount: integer('hit_count').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 用户文章攻克状态表
export const userArticleStatus = pgTable('user_article_status', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  articleId: integer('article_id').references(() => articles.id).notNull(),
  bestScore: decimal('best_score', { precision: 4, scale: 1 }).default('0').notNull(),
  isConquered: boolean('is_conquered').default(false).notNull(),
  isPerfect: boolean('is_perfect').default(false).notNull(),
  isUnlocked: boolean('is_unlocked').default(false).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  firstReadAt: timestamp('first_read_at').defaultNow().notNull(),
  bestReadAt: timestamp('best_read_at'),
})

// 邮箱验证码表
export const verificationCodes = pgTable('verification_codes', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  code: varchar('code', { length: 6 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  used: boolean('used').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 支付记录表
export const payments = pgTable('payments', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  type: subscriptionTypeEnum('type').notNull(),
  channel: varchar('channel', { length: 16 }).default('alipay').notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  articleId: integer('article_id').references(() => articles.id),
  tradeNo: varchar('trade_no', { length: 128 }),
  outTradeNo: varchar('out_trade_no', { length: 128 }).notNull().unique(),
  status: paymentStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  paidAt: timestamp('paid_at'),
})
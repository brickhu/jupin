import { z } from '@hono/zod-openapi'

import type {
  ArenaDetail,
  ArenaRecord,
  ArenaRecordsResponse,
  ArticleCard,
  ArticleDetail,
  ArticleRecordItem,
  ArticleRecordsResponse,
  ArticleWordItem,
  ChallengeRecord,
  ChallengeShareResponse,
  SubmissionAudioResponse,
  ChallengesResponse,
  EnergyLedgerItem,
  EnergyResponse,
  FavoriteItem,
  FavoritesResponse,
  Gender,
  GrowthRankResponse,
  GrowthRankRow,
  MeResponse,
  ProfileUpdateResponse,
  ParticipationRecord,
  ParticipationsResponse,
  LatestCardsResponse,
  LeaderboardRow,
  ScoreDimensions,
  ScoreParts,
  StreakDelta,
  StreakRecordDay,
  StreakRecordResponse,
  ShopGoodsItem,
  ShopGoodsResponse,
  ShopOrderResponse,
  StreakView,
  SubmissionStatusResponse,
  SubmitResponse,
  TokenResponse,
  VirtualPayData,
  WordScore,
} from '@jushuo/shared'

/**
 * ⭐⭐ **OpenAPI 的 schema 真相**（服务端这一侧）。
 *
 * ⚠️⚠️ 与 `packages/shared/src/types/api.ts` 的关系（**这是本轮最要紧的设计决定**）：
 *
 *    · 端侧现在按 `@jushuo/shared` 的 **TS 类型**写代码；把 schema 直接搬进 shared
 *      会连带把 `zod` 打进小程序包（体积），所以这一轮 schema 先住服务端。
 *    · 于是同一个契约存在两份表达（TS 类型 / Zod schema）⇒ **必须机器盯着**，
 *      否则就是"抄第二份真相"（项目元规则：重复即错误）。
 *      盯法在文件末尾：`Equal<>` 双向结构比对 —— **任一侧改歪都会 `tsc` 报错**。
 *    · 下一步（等接口全迁完、端侧再动）可以把 schema 变成唯一源、用 `z.infer` 出类型，
 *      那时候这份 `Equal` 比对就可以删掉 —— 但**不能提前**，因为端侧还在读老类型。
 *
 * ⚠️ 所有 schema 都用 `@hono/zod-openapi` 的 `z`（它给 Zod 打了 `.openapi()` 补丁），
 *    用原生 `zod` 的 `z` 会导致 `.openapi is not a function`。
 */

/* ---------- 基础 ---------- */

/** 难度四档：0 初级 / 1 中级 / 2 高级 / 3 专家（见 shared/level.ts） */
export const ArticleLevelSchema = z
  .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
  .openapi('ArticleLevel')

/** 视觉主题（背景/前景/配图）；老内容为 null ⇒ 端侧按 id 复算 */
export const ArticleThemeSchema = z
  .object({
    image: z.string().nullable(),
    background: z.string(),
    foreground: z.string(),
  })
  .openapi('ArticleTheme')

/** 可播引用：`kind` 决定 `full` 的含义（cloud = 云存储 fileID / http = 直接地址） */
export const AudioRefSchema = z
  .object({
    full: z.string(),
    kind: z.enum(['cloud', 'http']),
  })
  .openapi('AudioRef')

/** 标准音：AudioRef + 时长（算不出来是 null ⇒ 端侧只画按钮不画时长） */
export const StandardAudioSchema = AudioRefSchema.extend({
  durationMs: z.number().nullable(),
}).openapi('StandardAudio')

/**
 * ⭐ 首页卡片（「今天挑战」与「最新上线」**共用同一个形状**）。
 * ⚠️ 服务端返回它时一律带上**竞技统计**（参与人数 / 最高 / 最低）。
 */
export const ArticleCardSchema = z
  .object({
    /** 这一条排给哪一天（只有今日那一张有） */
    date: z.string().optional(),
    articleId: z.string(),
    text: z.string(),
    translation: z.string(),
    difficulty: ArticleLevelSchema.nullable(),
    tags: z.array(z.string()),
    audio: StandardAudioSchema.nullable(),
    /** 只有今日那一张有 */
    isScheduled: z.boolean().optional(),
    /** 只有今日那一张有 */
    isToday: z.boolean().optional(),
    participantCount: z.number().int(),
    topScore: z.number().nullable(),
    lowestScore: z.number().nullable(),
    theme: ArticleThemeSchema.nullable(),
  })
  .openapi('ArticleCard')

/* ---------- 响应包（统一信封 { ok: true, data }） ---------- */

/** 成功信封的工厂 —— 每个接口的 200 都是它的一个实例 */
export const okEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ ok: z.literal(true), data })

/** 失败信封（全站统一：`{ ok: false, error }`，可选 `code` 给端侧分支用） */
export const ErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
    /** 端侧据此分支（如 `ENERGY_EXHAUSTED` / `INVALID_REQUEST`） */
    code: z.string().optional(),
    /**
     * ⚠️ 能量不够时**额外带当前余额**（429 ENERGY_EXHAUSTED）——
     *    端侧直接显示「还差几点」而不是自己减一遍（见 reading.ts 的提示语）。
     */
    energy: z.number().int().optional(),
    /**
     * ⚠️ 业务分支的原因码（如 `UNFREEZE_FAILED` 的 `already-read-today` / `not-enough`）——
     *    端侧据此说更具体的话，而不是把原始错误码摆给用户。
     */
    reason: z.string().optional(),
  })
  .openapi('Error')

/** 常见失败响应：400 参数错 / 401 未登录 / 404 不存在 / 503 依赖不可用 */
export const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: ErrorSchema } },
  description,
})

export const LatestCardsResponseSchema = okEnvelope(
  z
    .object({
      /** 服务端认定的今天（端侧用它对齐自然日） */
      date: z.string(),
      items: z.array(ArticleCardSchema),
    })
    .openapi('LatestCardsResponse'),
)

/**
 * ⭐ **今日推荐**（`GET /api/articles/today?uid=<id>`，**uid 可省略 = 匿名**）——
 *    data 就是**一张标准 ArticleCard**（与 `/api/articles?latest=N` 的 items 同形
 *    ⇒ 端侧一套渲染）。
 *
 * ⚠️ 匿名（不带 uid / uid=0）时：**默认初级档**，在该档句子里**随机**挑一条、
 *    **参与人数多的更容易被抽中**，且**不写任何用户行**。
 *    带 uid 时按那个人的 24 小时窗口 + 难度档，确定性选句。
 *
 * ⚠️ 这里刻意**没有** myLevel / level / levelBasis / myBest / myAttempts：
 *    前三项是工程备注（用户 2026-09 明确不要），后两项走
 *    `GET /api/user/participation/{articleId}`。
 */
export const TodayArticleResponseSchema = okEnvelope(ArticleCardSchema).openapi(
  'TodayArticleResponse',
)

/* ---------- 我的：挑战记录 / 参与场次 / 能量 ---------- */

/** 挑战记录里的逐词结果（⚠️ `dp` 在 shared 里是 string，不是五值联合） */
export const ChallengeWordScoreSchema = z
  .object({ word: z.string(), score: z.number(), dp: z.string() })
  .openapi('ChallengeWordScore')

/** 用户录音的可播地址（与 AudioRef 同构，字段名叫 src） */
export const SubmissionAudioRefSchema = z
  .object({ kind: z.enum(['cloud', 'http']), src: z.string() })
  .openapi('SubmissionAudioRef')

/** ⭐ 「我的挑战」一条（一次提交一行） */
export const ChallengeRecordSchema = z
  .object({
    submissionId: z.string(),
    articleId: z.string(),
    scheduleDate: z.string().nullable(),
    score: z.number().nullable(),
    isConquered: z.boolean(),
    status: z.string(),
    aiComment: z.string().nullable(),
    text: z.string(),
    wordScores: z.array(ChallengeWordScoreSchema).nullable(),
    theme: ArticleThemeSchema.nullable(),
    at: z.string(),
  })
  .openapi('ChallengeRecord')

/** ⭐ 「参与场次」一条（一句一行 = 一个竞技场） */
export const ParticipationRecordSchema = z
  .object({
    articleId: z.string(),
    text: z.string(),
    words: z.number().int(),
    attempts: z.number().int(),
    bestScore: z.number(),
    worstScore: z.number(),
    rank: z.number().int(),
    participantCount: z.number().int(),
    lastAt: z.string(),
    lastScheduleDate: z.string(),
    theme: ArticleThemeSchema.nullable(),
  })
  .openapi('ParticipationRecord')

export const ChallengeRecordListSchema = okEnvelope(
  z.object({ items: z.array(ChallengeRecordSchema) }).openapi('ChallengesResponse'),
)

export const ParticipationRecordListSchema = okEnvelope(
  z.object({ items: z.array(ParticipationRecordSchema) }).openapi('ParticipationsResponse'),
)

/**
 * ⭐ 单取一条参与记录（`GET /api/user/participation/{articleId}`）。
 *
 * ⚠️ 没参与过时 **data 为 null**（不是 404、也不是一条全 0 的假记录）——
 *    客户端据此显示「还没挑战过」，而不是把 0 分当成成绩。
 */
export const ParticipationRecordResponseSchema = okEnvelope(
  ParticipationRecordSchema.nullable(),
).openapi('ParticipationRecordResponse')

/** ⭐ 竞技场一条（按句子）—— `ranks=1` 时才带名次/击败人数 */
export const ArenaRecordSchema = z
  .object({
    articleId: z.string(),
    bestScore: z.number().nullable(),
    attempts: z.number().int(),
    rank: z.number().int().nullable(),
    beatenCount: z.number().int().nullable(),
    isFavorite: z.boolean(),
  })
  .openapi('ArenaRecord')

export const ArenaRecordsResponseSchema = okEnvelope(
  z.object({ items: z.array(ArenaRecordSchema) }).openapi('ArenaRecordsResponse'),
)

/** ⭐ 「我在某一句上的历史挑战」一条（逐次；`score` 为 null = 那次没出分） */
export const ArticleRecordItemSchema = z
  .object({
    submissionId: z.string(),
    status: z.enum(['scored', 'failed']),
    score: z.number().nullable(),
    /** 第几次（**服务端现算**，不是库里的列 —— 见 services/submission.ts 的 attemptNoOf） */
    seq: z.number().int(),
    createdAt: z.string(),
    scheduleDate: z.string().nullable(),
    isPublic: z.boolean(),
  })
  .openapi('ArticleRecordItem')

export const ArticleRecordsResponseSchema = okEnvelope(
  z
    .object({
      items: z.array(ArticleRecordItemSchema),
      bestScore: z.number().nullable(),
      attempts: z.number().int(),
      rank: z.number().int().nullable(),
      participantCount: z.number().int(),
      lowestScore: z.number().nullable(),
    })
    .openapi('ArticleRecordsResponse'),
)

/** 能量流水一条 */
export const EnergyLedgerItemSchema = z
  .object({
    id: z.number().int(),
    delta: z.number().int(),
    reason: z.string(),
    refType: z.string(),
    refId: z.string(),
    createdAt: z.string(),
  })
  .openapi('EnergyLedgerItem')

export const EnergyResponseSchema = okEnvelope(
  z
    .object({
      energy: z.number(),
      perChallenge: z.number(),
      dailyFloor: z.number(),
      items: z.array(EnergyLedgerItemSchema),
      nextBefore: z.number().nullable(),
    })
    .openapi('EnergyResponse'),
)

/* ---------- 提交检测（核心链路） ---------- */

/** 引擎输出的词级结果（这次这个词读得怎么样） */
export const WordScoreSchema = z
  .object({
    word: z.string(),
    score: z.number(),
    dp: z.enum(['normal', 'omission', 'insertion', 'repetition', 'mispronunciation']),
    startMs: z.number(),
    endMs: z.number(),
  })
  .openapi('WordScore')

/** 讯飞四维（句级）—— mock / 历史数据可能没有 ⇒ 上层可选 */
export const ScoreDimensionsSchema = z
  .object({
    accuracy: z.number(),
    fluency: z.number(),
    standard: z.number(),
    integrity: z.number(),
  })
  .openapi('ScoreDimensions')

/** 我们自己那套分项明细（结果页「评分详情」）—— 加起来就是总分 */
export const ScorePartsSchema = z
  .object({
    prosody: z.number(),
    weakness: z.number(),
    accuracy: z.number(),
    fluency: z.number(),
    completeness: z.number(),
    gates: z.array(z.string()),
  })
  .openapi('ScoreParts')

/** streak 变化（只有真正打分成功的那一次才有） */
export const StreakDeltaSchema = z
  .object({
    streakDays: z.number().int(),
    streakBest: z.number().int(),
    counted: z.boolean(),
    delta: z.number().int(),
    unfreezeCards: z.number().int(),
  })
  .openapi('StreakDelta')

/** 成长值快照（这一把各加了多少） */
export const GrowthViewSchema = z
  .object({ self: z.number(), diligence: z.number(), standout: z.number() })
  .openapi('GrowthView')

/* ---------- 我的：连战与个人资料 ---------- */

/** ⭐ 连战展示视图（服务端算好、端侧只显示 —— 不让端侧重算"今天读没读"） */
export const StreakViewSchema = z
  .object({
    streakDays: z.number().int(),
    streakBest: z.number().int(),
    readToday: z.boolean(),
    unfreezeCards: z.number().int(),
    unfreezePending: z.number().int(),
    unfreezeExpiresOn: z.string().nullable(),
  })
  .openapi('StreakView')

/** 性别（只认两个值；null = 未填） */
export const GenderSchema = z.enum(['male', 'female']).openapi('Gender')

/** ⭐ 「我是谁」—— 状态卡上那几个累计数与连战都在这儿 */
export const MeResponseSchema = okEnvelope(
  z
    .object({
      id: z.number().int(),
      nickname: z.string().nullable(),
      /** ⚠️ 云存储 fileID（cloud://…），端侧要换址 */
      avatarUrl: z.string().nullable(),
      gender: GenderSchema.nullable(),
      age: z.number().int().nullable(),
      bio: z.string().nullable(),
      status: z.string(),
      energy: z.number(),
      challengedCount: z.number().int(),
      challengedRounds: z.number().int(),
      conqueredCount: z.number().int(),
      growth: GrowthViewSchema,
      streak: StreakViewSchema,
    })
    .openapi('MeResponse'),
)

/** 领取解冻卡的结果（`POST /api/user/claim`） */
export const ClaimRewardsResponseSchema = okEnvelope(
  z
    .object({ claimed: z.number().int(), streak: StreakViewSchema })
    .openapi('ClaimRewardsResponse'),
)


/** 榜单一行（中心 5 条 + 竞技场榜单共用） */
export const LeaderboardRowSchema = z
  .object({
    rank: z.number().int(),
    nickname: z.string(),
    /** ⚠️ 云存储 fileID（cloud://…），端侧要换址后才能进 <image src> */
    avatarUrl: z.string().nullable(),
    score: z.number(),
    isMe: z.boolean(),
  })
  .openapi('LeaderboardRow')

/**
 * ⭐⭐ **一次挑战的完整结果**（打分成功后才有）。
 * ⚠️ 字段多且大多可选：`parts`/`words`/`dimensions` 是增强项，缺失时端侧必须能优雅退化。
 */
export const SubmitResponseSchema = z
  .object({
    score: z.number(),
    aiComment: z.string().optional(),
    aiAdvice: z.string().optional(),
    parts: ScorePartsSchema.optional(),
    text: z.string().optional(),
    durationMs: z.number().optional(),
    scheduleDate: z.string().optional(),
    rank: z.number().int(),
    participantCount: z.number().int(),
    gapToPrev: z.number().nullable(),
    beatenCount: z.number().int(),
    isPersonalBest: z.boolean(),
    isConquered: z.boolean(),
    articleId: z.string(),
    isPublic: z.boolean(),
    theme: ArticleThemeSchema.nullable(),
    previousBest: z.number().nullable(),
    /** 这一把是这句的第几次（可空：序号只在"有结论"时才分配） */
    attempts: z.number().int().optional(),
    growth: GrowthViewSchema.optional(),
    leaderboard: z.array(LeaderboardRowSchema),
    words: z.array(WordScoreSchema).optional(),
    dimensions: ScoreDimensionsSchema.optional(),
    streak: StreakDeltaSchema.optional(),
  })
  .openapi('SubmitResponse')

/**
 * ⭐⭐ **提交状态**（`GET /api/user/submissions/:id`）—— 客户端轮询它直到 status 定型。
 * ⚠️ 这也是 `POST /api/user/submissions` 幂等命中时的 200 响应体。
 */
export const SubmissionStatusResponseSchema = okEnvelope(
  z
    .object({
      submissionId: z.string(),
      status: z.enum(['scoring', 'scored', 'failed']),
      /** 只在 scored 时存在 */
      result: SubmitResponseSchema.optional(),
      /** 只在 failed 时存在 */
      error: z.string().optional(),
    })
    .openapi('SubmissionStatusResponse'),
)

/**
 * ⭐ **上传成功的返回**（`POST /api/user/uploads`）。
 *
 * ⚠️ 它**没有**对应的共享 TS 类型：端侧只用 `audioKey` 拼提交参数
 *    （见 miniprogram/src/lib/api/upload.ts 的 UploadResult，那是端侧自己的形状）。
 *    所以这里不做双向比对 —— 但字段名必须与端侧读的一致（`audioKey`）。
 */
export const UploadResponseSchema = okEnvelope(
  z
    .object({
      /** 落库/对象存储里的 key（= `audio/{句子}/{用户}/{attemptId}.mp3`） */
      audioKey: z.string(),
      /** 实际写入字节数（排查用；端侧不消费） */
      bytes: z.number().int(),
    })
    .openapi('UploadResponse'),
)

/** 连战日历里的一天（read = 那天读了；unfreeze = 缺口是用解冻卡补的） */
export const StreakRecordDaySchema = z
  .object({ date: z.string(), kind: z.enum(['read', 'unfreeze']) })
  .openapi('StreakRecordDay')

/** ⭐ 连战日历（一个月）—— 端侧只负责画格子 */
export const StreakRecordResponseSchema = okEnvelope(
  z
    .object({
      month: z.string(),
      firstDay: z.string(),
      daysInMonth: z.number().int(),
      /** 1 号是周几（0 = 周日） */
      weekdayOfFirst: z.number().int(),
      today: z.string(),
      streakDays: z.number().int(),
      streakBest: z.number().int(),
      days: z.array(StreakRecordDaySchema),
      unfreezeCards: z.number().int(),
      unfreezePending: z.number().int(),
      unfreezeExpiresOn: z.string().nullable(),
    })
    .openapi('StreakRecordResponse'),
)

/** 补签的结果（`POST /api/user/unfreeze`）—— 卡不够时是 400 + Error(reason) */
export const UnfreezeResponseSchema = okEnvelope(
  z
    .object({
      /** 这次用掉几张解冻卡 */
      used: z.number().int(),
      streak: StreakViewSchema,
      /** 补完之后手上还剩几张 */
      unfreezeCards: z.number().int(),
    })
    .openapi('UnfreezeResponse'),
)

/** 保存资料之后回传的权威值（`POST /api/user/profile`） */
export const ProfileUpdateResponseSchema = okEnvelope(
  z
    .object({
      nickname: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      gender: GenderSchema.nullable(),
      age: z.number().int().nullable(),
      bio: z.string().nullable(),
    })
    .openapi('ProfileUpdateResponse'),
)


/* ---------- 句库详情 / 竞技场详情 ---------- */

/** 词重音三档：-1 轻读 / 0 普通 / 1 句重音落点 */
export const ArticleWordStressSchema = z
  .union([z.literal(-1), z.literal(0), z.literal(1)])
  .openapi('ArticleWordStress')

/** 内容侧的词级数据（音标 / 释义 / 音节）—— 与运行时的 WordScore 是两回事 */
export const ArticleWordItemSchema = z
  .object({
    text: z.string(),
    stress: ArticleWordStressSchema,
    syllables: z.array(z.string()),
    ipa: z.string(),
    meaning: z.string(),
    tip: z.string(),
  })
  .openapi('ArticleWordItem')

/** ⭐ 句子详情（**全量**）—— 阅读页要的那一份（含词级数据） */
export const ArticleDetailSchema = okEnvelope(
  z
    .object({
      id: z.string(),
      text: z.string(),
      translation: z.string(),
      words: z.array(ArticleWordItemSchema),
      links: z.array(z.string()),
      difficulty: ArticleLevelSchema.nullable(),
      challenge: z.string().nullable(),
      advice: z.string().nullable(),
      tags: z.array(z.string()),
      audio: StandardAudioSchema.nullable(),
      theme: ArticleThemeSchema.nullable(),
    })
    .openapi('ArticleDetail'),
)

/** ⭐ 竞技场详情 —— **按句子**寻址（同一句两次挑战看的是同一个场子） */
export const ArenaDetailSchema = okEnvelope(
  z
    .object({
      articleId: z.string(),
      text: z.string(),
      translation: z.string(),
      difficulty: ArticleLevelSchema.nullable(),
      tags: z.array(z.string()),
      /** 从这里发起的挑战该记到哪一天（按句子寻址 = 服务端的今天） */
      submissionDate: z.string(),
      isToday: z.boolean(),
      participantCount: z.number().int(),
      topScore: z.number().nullable(),
      lowestScore: z.number().nullable(),
      audio: StandardAudioSchema.nullable(),
      theme: ArticleThemeSchema.nullable(),
      leaderboard: z.array(LeaderboardRowSchema),
    })
    .openapi('ArenaDetail'),
)


/* ---------- 内容管理（admin 工具专用） ----------
 *
 * ⚠️ 这几条**没有** `@jushuo/shared` 的对应类型：它们只给 `tools/admin` 用，
 *    端侧不消费。所以**不做双向比对**，但要与 routes/admin.ts 的返回逐字段对齐。
 */

/** 三个判据的分数：**[词汇, 发音, 长度]**（内容生产期写下，见 shared/level.ts） */
export const DifficultyScoresSchema = z
  .tuple([z.number(), z.number(), z.number()])
  .openapi('DifficultyScores')

/** 句子行（`articles` 表原样透出）—— 管理台的列表与详情共用 */
export const AdminArticleRowSchema = z
  .object({
    id: z.string(),
    text: z.string().nullable(),
    translation: z.string().nullable(),
    scores: DifficultyScoresSchema.nullable(),
    challenge: z.string().nullable(),
    advice: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    words: z.array(ArticleWordItemSchema).nullable(),
    links: z.array(z.string()).nullable(),
    /** 上线状态（下架 = false，句子仍在、成绩仍在） */
    isActive: z.boolean(),
    /** ISO 时间串（DB 是 datetime，序列化后是字符串） */
    publishedAt: z.string().nullable(),
    /** 对象存储里的标准音 key（不是可播地址） */
    standardAudio: z.string().nullable(),
    theme: ArticleThemeSchema.nullable(),
    createdAt: z.string(),
    /** 难度档（0–3），内容生产期写下 */
    difficulty: z.number().int().nullable(),
  })
  .openapi('AdminArticleRow')

export const AdminArticleListResponseSchema = okEnvelope(
  z.object({ items: z.array(AdminArticleRowSchema) }).openapi('AdminArticleListResponse'),
)

export const AdminArticleDetailResponseSchema = okEnvelope(AdminArticleRowSchema)

export const AdminArticleWriteResponseSchema = okEnvelope(
  z.object({ id: z.string(), created: z.boolean() }).openapi('AdminArticleWriteResponse'),
)

/** 引用了这一句的用户数据条数（删除前先看它） */
export const ArticleRefsSchema = z
  .object({
    submissions: z.number().int(),
    participations: z.number().int(),
    favorites: z.number().int(),
  })
  .openapi('ArticleRefs')

export const AdminArticleDeleteResponseSchema = okEnvelope(
  z.object({ id: z.string(), refs: ArticleRefsSchema }).openapi('AdminArticleDeleteResponse'),
)

/**
 * ⚠️ 409 的形状与全站信封**不完全一样**：它在 `data` 里带 `refs`
 *    （`{ ok:false, error, data }`）—— 界面要拿引用数说清"删不得"。
 */
export const AdminArticleDeleteConflictSchema = z
  .object({ ok: z.literal(false), error: z.string(), data: z.object({ refs: ArticleRefsSchema }) })
  .openapi('AdminArticleDeleteConflict')

export const AdminAudioUploadResponseSchema = okEnvelope(
  z
    .object({ id: z.string(), audioKey: z.string(), bytes: z.number().int() })
    .openapi('AdminAudioUploadResponse'),
)


/* ---------- 身份 / 收藏 / 成长榜 / 商店 / 公开分享页 ---------- */

/** 登录换到的凭据（`POST /api/auth/login`）—— 云端容器通道下不用它（网关注入身份） */
export const TokenResponseSchema = okEnvelope(
  z
    .object({ token: z.string(), user: z.object({ id: z.number().int(), nickname: z.string().nullable() }) })
    .openapi('TokenResponse'),
)

/** 收藏开关的结果（PUT / DELETE /api/user/favorites/:articleId） */
export const FavoriteToggleResponseSchema = okEnvelope(
  z.object({ articleId: z.string(), favorited: z.boolean() }).openapi('FavoriteToggleResponse'),
)

/** 收藏列表里的一条（带句子正文与我的战绩） */
export const FavoriteItemSchema = z
  .object({
    articleId: z.string(),
    text: z.string(),
    translation: z.string(),
    difficulty: ArticleLevelSchema.nullable(),
    tags: z.array(z.string()),
    theme: ArticleThemeSchema.nullable(),
    favoritedAt: z.string(),
    bestScore: z.number().nullable(),
    attempts: z.number().int(),
  })
  .openapi('FavoriteItem')

export const FavoriteListResponseSchema = okEnvelope(
  z.object({ items: z.array(FavoriteItemSchema) }).openapi('FavoritesResponse'),
)

/** 成长榜一行（三个榜共用） */
export const GrowthRankRowSchema = z
  .object({
    rank: z.number().int(),
    nickname: z.string(),
    avatarUrl: z.string().nullable(),
    value: z.number(),
    isMe: z.boolean(),
  })
  .openapi('GrowthRankRow')

/** 三块成长榜（首页下方） */
export const GrowthRankResponseSchema = okEnvelope(
  z
    .object({
      self: z.array(GrowthRankRowSchema),
      diligence: z.array(GrowthRankRowSchema),
      standout: z.array(GrowthRankRowSchema),
    })
    .openapi('GrowthRankResponse'),
)

/** 商店商品一项 */
export const ShopGoodsItemSchema = z
  .object({
    code: z.string(),
    amount: z.number().int(),
    priceFen: z.number().int(),
    title: z.string(),
    subtitle: z.string(),
    badge: z.string().nullable(),
    sellable: z.boolean(),
  })
  .openapi('ShopGoodsItem')

export const ShopGoodsResponseSchema = okEnvelope(
  z
    .object({ items: z.array(ShopGoodsItemSchema), payEnv: z.number().int() })
    .openapi('ShopGoodsResponse'),
)

/** 虚拟支付的签名数据（端侧把它交给 wx.requestVirtualPayment） */
export const VirtualPayDataSchema = z
  .object({
    mode: z.enum(['short_series_goods', 'short_series_coin']),
    signData: z.string(),
    paySig: z.string(),
    signature: z.string(),
  })
  .openapi('VirtualPayData')

export const ShopOrderResponseSchema = okEnvelope(
  z
    .object({
      outTradeNo: z.string(),
      amountFen: z.number().int(),
      points: z.number().int(),
      mockPaid: z.boolean(),
      payData: VirtualPayDataSchema,
    })
    .openapi('ShopOrderResponse'),
)

/** ⭐ 分享出去的「一次挑战结果」（`GET /api/challenge/:sid`）—— **链接即凭据**，无需登录 */
export const ChallengeShareResponseSchema = okEnvelope(
  z
    .object({
      owner: z.object({
        id: z.number().int(),
        nickname: z.string(),
        avatarUrl: z.string().nullable(),
      }),
      result: SubmitResponseSchema,
      /** null = 这段音频不在了（或作者关了公开） */
      audio: SubmissionAudioRefSchema.nullable(),
      at: z.string(),
    })
    .openapi('ChallengeShareResponse'),
)

/** ⭐ 单取一段录音的可播地址（`GET /api/challenge/:sid/audio`）—— audio 为 null = 音频不在了 */
export const SubmissionAudioResponseSchema = okEnvelope(
  z.object({ audio: SubmissionAudioRefSchema.nullable() }).openapi('SubmissionAudioResponse'),
)

/** 单人主页（`GET /api/profile/:id`）—— 公开，不含"我的"私有数据 */
export const PublicProfileResponseSchema = okEnvelope(
  z
    .object({
      id: z.number().int(),
      nickname: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      streakDays: z.number().int(),
      conqueredCount: z.number().int(),
      challengedRounds: z.number().int(),
      growth: GrowthViewSchema,
    })
    .openapi('PublicProfileResponse'),
)

/* ---------- ⭐ 与共享 TS 类型的双向比对（漂移在这里报错） ---------- */

/**
 * 结构等价判定：两边互相可赋值才算相等。
 * ⚠️ 它**只在类型层**起作用（`tsc --noEmit` 时检查），运行期零开销。
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** 每一对都得是 `true`；写成 `false` 时 TS 会在这里报错 */
type _CardParity = Equal<z.infer<typeof ArticleCardSchema>, ArticleCard>
type _LatestParity = Equal<
  z.infer<typeof LatestCardsResponseSchema>['data'],
  LatestCardsResponse
>
type _ParticipationOneParity = Equal<
  z.infer<typeof ParticipationRecordResponseSchema>['data'],
  ParticipationRecord | null
>
type _SubmitParity = Equal<z.infer<typeof SubmitResponseSchema>, SubmitResponse>
type _StatusParity = Equal<
  z.infer<typeof SubmissionStatusResponseSchema>['data'],
  SubmissionStatusResponse
>
type _WordsParity = Equal<z.infer<typeof WordScoreSchema>, WordScore>
type _DimsParity = Equal<z.infer<typeof ScoreDimensionsSchema>, ScoreDimensions>
type _PartsParity = Equal<z.infer<typeof ScorePartsSchema>, ScoreParts>
type _StreakParity = Equal<z.infer<typeof StreakDeltaSchema>, StreakDelta>
type _RowParity = Equal<z.infer<typeof LeaderboardRowSchema>, LeaderboardRow>
type _ChallengeParity = Equal<z.infer<typeof ChallengeRecordSchema>, ChallengeRecord>
type _ChallengesParity = Equal<
  z.infer<typeof ChallengeRecordListSchema>['data'],
  ChallengesResponse
>
type _ParticipationParity = Equal<z.infer<typeof ParticipationRecordSchema>, ParticipationRecord>
type _ParticipationsParity = Equal<
  z.infer<typeof ParticipationRecordListSchema>['data'],
  ParticipationsResponse
>
type _LedgerParity = Equal<z.infer<typeof EnergyLedgerItemSchema>, EnergyLedgerItem>
type _EnergyParity = Equal<z.infer<typeof EnergyResponseSchema>['data'], EnergyResponse>
type _ArenaRecParity = Equal<z.infer<typeof ArenaRecordSchema>, ArenaRecord>
type _ArenaResParity = Equal<
  z.infer<typeof ArenaRecordsResponseSchema>['data'],
  ArenaRecordsResponse
>
type _ArtRecParity = Equal<z.infer<typeof ArticleRecordItemSchema>, ArticleRecordItem>
type _ArtResParity = Equal<
  z.infer<typeof ArticleRecordsResponseSchema>['data'],
  ArticleRecordsResponse
>
type _StreakViewParity = Equal<z.infer<typeof StreakViewSchema>, StreakView>
type _MeParity = Equal<z.infer<typeof MeResponseSchema>['data'], MeResponse>
type _GenderParity = Equal<z.infer<typeof GenderSchema>, Gender>
type _StreakDayParity = Equal<z.infer<typeof StreakRecordDaySchema>, StreakRecordDay>
type _StreakRecParity = Equal<
  z.infer<typeof StreakRecordResponseSchema>['data'],
  StreakRecordResponse
>
type _ProfileParity = Equal<
  z.infer<typeof ProfileUpdateResponseSchema>['data'],
  ProfileUpdateResponse
>
type _WordItemParity = Equal<z.infer<typeof ArticleWordItemSchema>, ArticleWordItem>
type _ArticleDetailParity = Equal<
  z.infer<typeof ArticleDetailSchema>['data'],
  ArticleDetail
>
type _ArenaDetailParity = Equal<z.infer<typeof ArenaDetailSchema>['data'], ArenaDetail>
type _TokenParity = Equal<z.infer<typeof TokenResponseSchema>['data'], TokenResponse>
type _GrowthRowParity = Equal<z.infer<typeof GrowthRankRowSchema>, GrowthRankRow>
type _GrowthResParity = Equal<
  z.infer<typeof GrowthRankResponseSchema>['data'],
  GrowthRankResponse
>
type _GoodsItemParity = Equal<z.infer<typeof ShopGoodsItemSchema>, ShopGoodsItem>
type _GoodsResParity = Equal<z.infer<typeof ShopGoodsResponseSchema>['data'], ShopGoodsResponse>
type _PayDataParity = Equal<z.infer<typeof VirtualPayDataSchema>, VirtualPayData>
type _OrderParity = Equal<z.infer<typeof ShopOrderResponseSchema>['data'], ShopOrderResponse>
type _ShareParity = Equal<
  z.infer<typeof ChallengeShareResponseSchema>['data'],
  ChallengeShareResponse
>
type _FavItemParity = Equal<z.infer<typeof FavoriteItemSchema>, FavoriteItem>
type _FavResParity = Equal<
  z.infer<typeof FavoriteListResponseSchema>['data'],
  FavoritesResponse
>
type _SubAudioParity = Equal<
  z.infer<typeof SubmissionAudioResponseSchema>['data'],
  SubmissionAudioResponse
>

// ⚠️ 这两个常量是为了让上面三个类型别名**不被 TS 当成未使用而忽略**（noUnusedLocals 场景）。
//    它们没有任何运行期意义，但删掉会让上面的漂移检查静默失效。
const _parityChecks: [
  _CardParity,
  _LatestParity,
  _ParticipationOneParity,
  _SubmitParity,
  _StatusParity,
  _WordsParity,
  _DimsParity,
  _PartsParity,
  _StreakParity,
  _RowParity,
  _ChallengeParity,
  _ChallengesParity,
  _ParticipationParity,
  _ParticipationsParity,
  _LedgerParity,
  _EnergyParity,
  _ArenaRecParity,
  _ArenaResParity,
  _ArtRecParity,
  _ArtResParity,
  _StreakViewParity,
  _MeParity,
  _GenderParity,
  _StreakDayParity,
  _StreakRecParity,
  _ProfileParity,
  _WordItemParity,
  _ArticleDetailParity,
  _ArenaDetailParity,
  _TokenParity,
  _GrowthRowParity,
  _GrowthResParity,
  _GoodsItemParity,
  _GoodsResParity,
  _PayDataParity,
  _OrderParity,
  _ShareParity,
  _FavItemParity,
  _FavResParity,
  _SubAudioParity,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
void _parityChecks

import { z } from '@hono/zod-openapi'

import type {
  ArenaRecord,
  ArenaRecordsResponse,
  ArticleCard,
  ArticleRecordItem,
  ArticleRecordsResponse,
  ChallengeRecord,
  ChallengesResponse,
  EnergyLedgerItem,
  EnergyResponse,
  ParticipationRecord,
  ParticipationsResponse,
  LatestCardsResponse,
  LeaderboardRow,
  ScoreDimensions,
  ScoreParts,
  StreakDelta,
  SubmissionStatusResponse,
  SubmitResponse,
  TodayResponse,
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

export const TodayResponseSchema = okEnvelope(
  z
    .object({
      entry: ArticleCardSchema,
      myLevel: ArticleLevelSchema,
      level: ArticleLevelSchema,
      levelBasis: z.string(),
      myBest: z.number().nullable(),
      myAttempts: z.number().int(),
    })
    .openapi('TodayResponse'),
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
type _TodayParity = Equal<z.infer<typeof TodayResponseSchema>['data'], TodayResponse>
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

// ⚠️ 这两个常量是为了让上面三个类型别名**不被 TS 当成未使用而忽略**（noUnusedLocals 场景）。
//    它们没有任何运行期意义，但删掉会让上面的漂移检查静默失效。
const _parityChecks: [
  _CardParity,
  _LatestParity,
  _TodayParity,
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
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
void _parityChecks

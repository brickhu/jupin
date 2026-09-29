import { z } from '@hono/zod-openapi'

import type {
  ArticleCard,
  LatestCardsResponse,
  TodayResponse,
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
    code: z.string().optional(),
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

// ⚠️ 这两个常量是为了让上面三个类型别名**不被 TS 当成未使用而忽略**（noUnusedLocals 场景）。
//    它们没有任何运行期意义，但删掉会让上面的漂移检查静默失效。
const _parityChecks: [_CardParity, _LatestParity, _TodayParity] = [true, true, true]
void _parityChecks

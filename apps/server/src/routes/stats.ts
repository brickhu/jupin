import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import { favoriteCountsOf } from '../services/favorites'
import { listArticleStats } from '../services/article-participations'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  ArticleFavoriteCountsResponseSchema,
  ArticleStatsResponseSchema,
  errorResponse,
} from '../openapi/schemas'

/**
 * ⭐⭐ **统计资源**（`/api/stats/*`，公开）—— "某几句的各是多少"都收在这里。
 *
 * 用户 2026-09 定的结构：**统计与句子内容分开**（不挂在 `/api/article/{id}` 下），
 * 因为它们是**按 ids 批量的聚合**，服务的是列表页（首页一屏 6 句、句库一屏 50 句）——
 * 逐句查就是 N 次往返：
 *
 *   · `GET /api/stats/participation?ids=a,b,c`    —— 参与统计（人数 / 最高 / 最低）
 *   · `GET /api/stats/favorite-count?ids=a,b,c`   —— 收藏总量
 *
 * ⚠️⚠️ 两条**形状完全一样**：`{ items: [{ articleId, ... }] }`、都按请求的 ids
 *    **零值补齐**（没人参与 ⇒ 0 / null，没人收藏 ⇒ 0），端侧按 articleId 直接取。
 *    ⇒ 加第三种统计时**照着这两条再来一条**（`/api/stats/xxx`），
 *      **不要**做成 `?type=xxx` 的分发器：那会让响应类型变成 oneOf，
 *      而本仓库的 OpenAPI parity 检查（`openapi/schemas.ts` 的 `_parityChecks`）
 *      要求"schema 与 TS 类型逐字段相等"—— 一个端点多种形状当场失效。
 *
 * ⚠️ 单条句子的详情 / 榜单 / 参与者**不在这里**：那是句子的子资源，在 `/api/article/{id}/*`。
 */
export const statsRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

/** 统计接口一次最多查多少句（与句库列表上限一致；防着一屏几百个 id 打进来） */
const MAX_STATS_IDS = 100

/**
 * `ids=a,b,c` → 去重后的 id 数组。
 * @returns null = 参数不合法（调用方据此回 400）
 */
function parseStatsIds(raw: string | undefined): string[] | null {
  const ids = [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0))]
  if (ids.length === 0 || ids.length > MAX_STATS_IDS) return null
  return ids
}

const IDS_DESC = `逗号分隔的句子 id，最多 ${MAX_STATS_IDS} 个`

const participationStatsRoute = createRoute({
  method: 'get',
  path: '/participation',
  tags: ['统计'],
  summary: '参与统计（一条 SQL 批量查人数 / 最高 / 最低）',
  description:
    '公开接口。`ids` 是逗号分隔的句子 id（**最多 100 个**）。\n\n' +
    '⚠️ 统计是 `participations` 的**聚合派生值**，与句子内容分开存放 ——\n' +
    '句子下架 / 内容换版之后，只要有参与记录，这三个数照样查得到。\n' +
    '⚠️ 返回值按请求的 ids 零值补齐（没人参与 ⇒ `participantCount: 0`、`topScore: null`）。',
  request: { query: z.object({ ids: z.string().optional().openapi({ description: IDS_DESC }) }) },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleStatsResponseSchema } },
      description: '成功',
    },
    400: errorResponse(`ids 为空或超过 ${MAX_STATS_IDS} 个`),
  },
})

statsRoutes.openapi(participationStatsRoute, async (c) => {
  const ids = parseStatsIds(c.req.valid('query').ids)
  if (!ids) return c.json({ ok: false, error: `ids 不能为空，且最多 ${MAX_STATS_IDS} 个` }, 400)
  return c.json({ ok: true, data: { items: await listArticleStats(ids) } }, 200)
})

const favoriteCountStatsRoute = createRoute({
  method: 'get',
  path: '/favorite-count',
  tags: ['统计'],
  summary: '收藏统计（一条 SQL 批量查每句被多少人收藏）',
  description:
    '公开接口，**不需要身份**（这是"大家"的数字）。`ids` 是逗号分隔的句子 id（**最多 100 个**）。\n\n' +
    '⚠️ 它是 `favorites`（一人一句一行）的**现算聚合**，不是冗余计数列 ——\n' +
    '永远准、不需要 ±1、也不需要重建与对账。\n' +
    '⚠️ 与「我收藏了吗」（`/api/user/favorited`）是两件事：那个答"我"，这个答"大家"。\n' +
    '⚠️ 按请求的 ids 零值补齐：没听过的 id 回 `favoriteCount: 0`（**不是 404**）——\n' +
    '收藏行不挂外键，句子下架后行还在，"零人收藏"与"句子不存在"对这个数同一个答案。',
  request: { query: z.object({ ids: z.string().optional().openapi({ description: IDS_DESC }) }) },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleFavoriteCountsResponseSchema } },
      description: '成功',
    },
    400: errorResponse(`ids 为空或超过 ${MAX_STATS_IDS} 个`),
  },
})

statsRoutes.openapi(favoriteCountStatsRoute, async (c) => {
  const ids = parseStatsIds(c.req.valid('query').ids)
  if (!ids) return c.json({ ok: false, error: `ids 不能为空，且最多 ${MAX_STATS_IDS} 个` }, 400)
  return c.json({ ok: true, data: { items: await favoriteCountsOf(ids) } }, 200)
})

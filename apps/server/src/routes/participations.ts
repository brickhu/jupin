import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import { listArticleParticipations, listArticleStats } from '../services/article-participations'
import { clampLimit, MAX_ARTICLE_LIMIT } from '../services/article-list'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  ArticleParticipationsResponseSchema,
  ArticleStatsResponseSchema,
  errorResponse,
} from '../openapi/schemas'

/**
 * ⭐⭐ **参与资源**（`/api/participations/*`，公开）。
 *
 * 用户 2026-09 定的结构（L1 解耦）：参与数据是**用户资产**，不是句子内容的附属物 ——
 * 所以它有自己的根路径，**不挂在 `/api/articles/{id}` 下面**，也**不要求句子还在**：
 *
 *   · `GET /api/participations?articleId=…`        —— 参与者 / 榜单（sort=time|score + 分页）
 *   · `GET /api/participations/stats?ids=a,b,c`    —— 参与统计（人数 / 最高 / 最低）
 *
 * ⚠️⚠️ 为什么另立根路径（而不是 `/api/articles/{id}/participations`）：
 *    那样等于把"参与数据能不能读"绑在"这一行内容还在不在"上。
 *    句子可以下架、内容可以换版（id = 内容哈希），但用户在那个 id 下读过的记录
 *    与统计必须照样读得到（记录自带 words/links 快照，见 services/participations.ts）。
 *
 * ⚠️ 我的参与不在这里：`GET /api/user/participation/{articleId}`（鉴权），
 *    我的收藏是 `GET /api/user/is-favorite`（鉴权）—— 那两条按用户寻址。
 */
export const participationsRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

/** 统计接口一次最多查多少句（与句库列表上限一致；防着一屏几百个 id 打进来） */
const MAX_STATS_IDS = 100

/** offset 只接受非负整数；非法值按 0 处理（只读接口，为它报错没有意义） */
function clampOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '0', 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 10_000)
}

/**
 * ⭐ **参与统计**（`GET /api/participations/stats?ids=a,b,c`）。
 *
 * ⚠️ 注册顺序：`/stats` 是固定段，`/` 是根 —— 两者不冲突，但把它写在前面更省心。
 * ⚠️ 返回值按请求的 ids **零值补齐**，端侧可以直接按 articleId 取。
 */
const articleStatsRoute = createRoute({
  method: 'get',
  path: '/stats',
  tags: ['参与'],
  summary: '参与统计（一条 SQL 批量查人数 / 最高 / 最低）',
  description:
    '公开接口。`ids` 是逗号分隔的句子 id（**最多 100 个**）。\n\n' +
    '⚠️ 统计是 `participations` 的**聚合派生值**，与句子内容分开存放 ——\n' +
    '句子下架 / 内容换版之后，只要有参与记录，这三个数照样查得到。\n' +
    '⚠️ 返回值按请求的 ids 零值补齐（没人参与 ⇒ `participantCount: 0`、`topScore: null`）。',
  request: {
    query: z.object({ ids: z.string().optional() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleStatsResponseSchema } },
      description: '成功',
    },
    400: errorResponse('ids 为空或超过 100 个'),
  },
})

participationsRoutes.openapi(articleStatsRoute, async (c) => {
  const ids = (c.req.valid('query').ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (ids.length === 0) return c.json({ ok: false, error: 'ids 不能为空' }, 400)
  if (ids.length > MAX_STATS_IDS) {
    return c.json({ ok: false, error: `ids 最多 ${MAX_STATS_IDS} 个` }, 400)
  }

  const items = await listArticleStats(ids)
  return c.json({ ok: true, data: { items } }, 200)
})

/**
 * ⭐ **参与者 / 榜单**（`GET /api/participations?articleId=…`）。
 *
 * `sort=score` 就是榜单（按最高分倒序，arena 页 limit=20）；
 * `sort=time` 是"最近谁来过"。每行都带全局 `rank`（与 sort 无关）。
 */
const articleParticipationsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['参与'],
  summary: '某一句的参与记录（sort=time|score，limit/offset 分页）',
  description:
    '公开接口。按句子查"谁参与过这一句"，一行 = 一个用户。\n\n' +
    '· `articleId`：**必填**，句子 id（内容哈希）\n' +
    '· `sort`：`time`（默认，按最新参与时间倒序）或 `score`（按最高分倒序 = 榜单）\n' +
    '· `limit`：1..100，默认 20\n' +
    '· `offset`：非负整数，默认 0\n\n' +
    '⚠️ 每一行都带 `rank`（按最高分算的**全局**名次，与 `sort` 无关）。\n' +
    '⚠️ 句子不存在（已下架 / 内容换版）**不是错误**：有参与记录就照常返回，没有就是空数组。',
  request: {
    query: z.object({
      articleId: z.string(),
      sort: z.enum(['time', 'score']).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleParticipationsResponseSchema } },
      description: '成功（没人参与就是空数组 + total=0）',
    },
    400: errorResponse('缺 articleId'),
  },
})

participationsRoutes.openapi(articleParticipationsRoute, async (c) => {
  const q = c.req.valid('query')
  const articleId = q.articleId.trim()
  if (!articleId) return c.json({ ok: false, error: '缺 articleId' }, 400)

  const data = await listArticleParticipations(articleId, {
    sort: q.sort ?? 'time',
    limit: clampLimit(q.limit, 20, MAX_ARTICLE_LIMIT),
    offset: clampOffset(q.offset),
  })
  return c.json({ ok: true, data }, 200)
})

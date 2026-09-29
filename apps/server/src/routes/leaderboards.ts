import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { Variables } from '../middleware/auth'
import { topGrowthBoards } from '../services/growth-rank'

/**
 * ⭐ 成长榜（首页那三块 TOP10）。
 *
 * ⚠️ 单独一个接口、而不是塞进首页那个列表：
 *    · 它与「今天读哪一句」无关，是**全站累计**的排行榜 —— 两件事不该共用一个响应
 *    · 端侧本来就是并发拉的（首页那一次 load 里还有 refreshMe），多一个请求不多一次往返
 *    · 首页那三块在页面最下方，慢一点不影响首屏
 */
export const leaderboardsRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })
import { defaultHook } from '../openapi'
import {
  GrowthRankResponseSchema,
} from '../openapi/schemas'


const growthBoardsRoute = createRoute({
  method: 'get',
  path: '/growth',
  tags: ['排行榜'],
  summary: '成长榜（按需取某几块：?self / ?diligence / ?standout；都不带 = 三块全给）',
  description:
    '⚠️ 三块榜各自独立：\n\n' +
    '· `?self`      自我超越\n' +
    '· `?diligence` 坚持不懈\n' +
    '· `?standout`  人中翘楚\n\n' +
    '可以多选（`?self&standout`）。**带上即算，忽略值**。\n' +
    '⚠️ 一个都不带 ⇒ 三块全给（首页一次拿全）。\n' +
    '⚠️ 没点名的键**不出现**（不是空数组 —— 空数组的含义是"这块榜上没人"）。',
  /**
   * ⚠️ 三个参数都是**旗标式**（`?self` 即可，不需要值）。
   *    判据是"参数有没有出现"，不是它的值。
   *
   * ⚠️ 这里原来还写了一个 `request: { body: z.object({}) }` —— **GET 不该有 body**，
   *    它会在 spec 里生成一个不存在的请求体（Swagger/客户端生成器都会照做）。已删。
   */
  request: {
    query: z.object({
      self: z.string().optional().openapi({ description: '要「自我超越」这块榜（带上即可）' }),
      diligence: z.string().optional().openapi({ description: '要「坚持不懈」这块榜（带上即可）' }),
      standout: z.string().optional().openapi({ description: '要「人中翘楚」这块榜（带上即可）' }),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GrowthRankResponseSchema } },
      description: '成功（只包含点名的那几块）',
    },
  },
})

leaderboardsRoutes.openapi(growthBoardsRoute, async (c) => {
  const q = c.req.valid('query')
  /** ⚠️ 只看"有没有带这个参数"，不看值（`?self` / `?self=1` / `?self=0` 都算点了名） */
  const want = {
    self: q.self !== undefined,
    diligence: q.diligence !== undefined,
    standout: q.standout !== undefined,
  }
  const userId = c.get('userId')
  return c.json({ ok: true, data: await topGrowthBoards(userId, want) }, 200)
})

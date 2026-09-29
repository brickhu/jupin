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
  tags: ['句库'],
  summary: '成长榜（三块 TOP10）',
  request: { body: { content: { 'application/json': { schema: z.object({}) } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: GrowthRankResponseSchema } },
      description: '成功',
    },
  },
})

leaderboardsRoutes.openapi(growthBoardsRoute, async (c) => {
  const userId = c.get('userId')
  return c.json({ ok: true, data: await topGrowthBoards(userId) }, 200)
})

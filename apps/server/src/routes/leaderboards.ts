import { Hono } from 'hono'

import type { Variables } from '../middleware/auth'
import { topGrowthBoards } from '../services/growth-rank'

/**
 * ⭐ 成长榜（首页那三块 TOP10）。
 *
 * ⚠️ 单独一个接口、而不是塞进 /api/schedules：
 *    · 它与「今天读哪一句」无关，是**全站累计**的排行榜 —— 两件事不该共用一个响应
 *    · 端侧本来就是并发拉的（首页那一次 load 里还有 refreshMe），多一个请求不多一次往返
 *    · 首页那三块在页面最下方，慢一点不影响首屏
 */
export const leaderboardsRoutes = new Hono<{ Variables: Variables }>()

leaderboardsRoutes.get('/growth', async (c) => {
  const userId = c.get('userId')
  return c.json({ ok: true, data: await topGrowthBoards(userId) })
})

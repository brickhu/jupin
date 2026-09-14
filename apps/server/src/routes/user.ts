import { Hono } from 'hono'
import { getConqueredByStars, getTotalConquered } from '../services/conquest'
import type { Variables } from '../middleware/auth'

export const userRoutes = new Hono<{ Variables: Variables }>()

/** 个人主页：能力边界图数据 + 冷却状态 */
userRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const userId = c.get('userId')

  const [byStars, total] = await Promise.all([
    getConqueredByStars(userId),
    getTotalConquered(userId),
  ])

  return c.json({
    ok: true,
    data: {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      isMember: !!user.subscriptionEnd && user.subscriptionEnd > new Date(),
      nextFreeAt: user.nextFreeAt.toISOString(),
      conqueredCount: total,
      conqueredByStars: byStars,
    },
  })
})

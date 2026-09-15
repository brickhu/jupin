import { Hono } from 'hono'
import { getConqueredByDifficulty, getTotalConquered } from '../services/conquest'
import type { Variables } from '../middleware/auth'

export const userRoutes = new Hono<{ Variables: Variables }>()

/** 个人主页：能力边界图数据 + 冷却状态 */
userRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const userId = c.get('userId')

  const [byDifficulty, total] = await Promise.all([
    getConqueredByDifficulty(userId),
    getTotalConquered(userId),
  ])

  return c.json({
    ok: true,
    data: {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      status: user.status,
      isMember: !!user.memberUntil && user.memberUntil > new Date(),
      nextFreeAt: user.nextFreeAt.toISOString(),
      conqueredCount: total,
      conqueredByDifficulty: byDifficulty,
    },
  })
})

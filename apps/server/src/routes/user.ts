import { Hono } from 'hono'
import { getTotalConquered } from '../services/conquest'
import { readStreakView } from '../services/streak'
import type { Variables } from '../middleware/auth'

export const userRoutes = new Hono<{ Variables: Variables }>()

/** 个人主页：Streak / 徽章 + 冷却状态 */
userRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const userId = c.get('userId')

  // ⚠️ Streak 视图一律现算（它由库里四个字段纯推导），不缓存：
  //    跨过零点之后「今天读没读」会翻面，缓存会让它停在昨天。
  const [streak, conqueredCount] = await Promise.all([
    readStreakView(userId),
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
      conqueredCount,
      streak,
    },
  })
})

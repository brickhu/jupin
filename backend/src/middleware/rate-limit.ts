import { createMiddleware } from 'hono/factory'
import { db } from '../db'
import { users } from '../db/schema'
import { eq } from 'drizzle-orm'

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  // 仅对评分接口做限流
  if (!c.req.path.includes('/api/readings/score')) {
    return await next()
  }

  const userId = c.get('userId') as number
  const [user] = await db.select({
    dailySubmissionsLeft: users.dailySubmissionsLeft,
    dailyResetDate: users.dailyResetDate,
    subscriptionEnd: users.subscriptionEnd,
  }).from(users).where(eq(users.id, userId)).limit(1)

  if (!user) {
    return c.json({ error: '用户不存在' }, 401)
  }

  const today = new Date().toISOString().split('T')[0]

  // 跨天重置额度
  if (user.dailyResetDate !== today) {
    const isPro = user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date()
    const newLimit = isPro ? 500 : 5
    await db.update(users).set({
      dailySubmissionsLeft: newLimit,
      dailyResetDate: today,
    }).where(eq(users.id, userId))
    c.set('dailyLimit', newLimit)
  } else {
    c.set('dailyLimit', user.dailySubmissionsLeft)
  }

  await next()
})
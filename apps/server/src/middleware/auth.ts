import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { verifyToken } from '../lib/token'

export interface Variables {
  userId: number
  user: typeof users.$inferSelect
}

export const authMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: '未登录' }, 401)
  }
  const payload = verifyToken(header.slice(7))
  if (!payload) {
    return c.json({ ok: false, error: '登录已过期' }, 401)
  }
  const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1)
  if (!user) {
    return c.json({ ok: false, error: '用户不存在' }, 401)
  }
  // ⚠️ Hono 的 Variables 类型必须显式声明，否则 c.get('userId') 会报 TS2769
  c.set('userId', user.id)
  c.set('user', user)
  await next()
})

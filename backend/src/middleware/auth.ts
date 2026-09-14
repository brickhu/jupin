import { createMiddleware } from 'hono/factory'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { users } from '../db/schema'
import { eq } from 'drizzle-orm'

export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '未登录' }, 401)
  }

  const token = authHeader.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: number }
    c.set('userId', payload.userId)

    // 加载用户信息到 context
    const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1)
    if (!user) {
      return c.json({ error: '用户不存在' }, 401)
    }
    c.set('user', user)

    await next()
  } catch {
    return c.json({ error: 'token 无效或已过期' }, 401)
  }
})
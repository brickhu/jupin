import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { verifyToken } from '../lib/token'
import { getOrCreateUserByOpenid, type User } from '../services/user'

export interface Variables {
  userId: number
  user: User
}

/**
 * 鉴权 —— 两条入口，一个出口。
 *
 * ① 微信云托管内网调用（wx.cloud.callContainer）
 *    微信网关注入 x-wx-openid / x-wx-source 等 header，官方原话是
 *    「开发者可以完全信任这些 header 头」。
 *    ⭐ 所以这条路径**不需要 wx.login、不需要 token** —— 打开即已登录。
 *
 * ② Bearer token（本地联调 / 公网访问）
 *    走 /api/auth/login 用 code 换 token，保留给没有云环境的开发场景。
 *
 * ⚠️ 路径①必须同时要求 x-wx-source 存在。
 *    公网请求**不携带任何 x-wx-* header** —— 只看 x-wx-openid 的话，
 *    任何人手写一个 header 就能冒充任意用户。这是本文件唯一的安全要害。
 *
 * ⚠️ header 名大小写不敏感，Hono 的 c.req.header() 已做归一化，写小写即可。
 */
export const authMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  let user: User | undefined

  // ---- 路径 ①：微信云托管内网调用 ----
  if (c.req.header('x-wx-source')) {
    // 资源复用场景没有 x-wx-openid，OpenID 在 x-wx-from-openid
    const openid = c.req.header('x-wx-openid') ?? c.req.header('x-wx-from-openid')
    if (openid) user = await getOrCreateUserByOpenid(openid)
  }

  // ---- 路径 ②：Bearer token ----
  if (!user) {
    const header = c.req.header('Authorization')
    if (!header?.startsWith('Bearer ')) {
      return c.json({ ok: false, error: '未登录' }, 401)
    }
    const payload = verifyToken(header.slice(7))
    if (!payload) {
      return c.json({ ok: false, error: '登录已过期' }, 401)
    }
    const [found] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1)
    if (!found) {
      return c.json({ ok: false, error: '用户不存在' }, 401)
    }
    user = found
  }

  // ⚠️ Hono 的 Variables 类型必须显式声明，否则 c.get('userId') 会报 TS2769
  c.set('userId', user.id)
  c.set('user', user)
  await next()
})

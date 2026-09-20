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

    /**
     * ⭐⭐ token 里带 openid 时，**一律走「没有就创建」**，而不是「按 userId 查、查不到就 401」。
     *
     * ⚠️ 两者的差别不是风格，是**能不能自愈**：
     *    · 按 userId 查：那一行数据没了，这张 token 就永远是废纸 ——
     *      用户被永久挡在门外，而他的身份（微信那边的 openid）根本没变。
     *      清库、换环境、误删账号之后，每个人都要手动重启小程序才能恢复。
     *    · 按 openid 取或建：行没了就再建一行，openid 还是同一个，对他而言**什么都没发生**。
     *
     * ⚠️ 这不会绕过封禁：被禁的账号 status='banned' 但仍然**存在**，
     *    getOrCreateUserByOpenid 会原样返回它，不会重建。只有真被删掉的行才会重建。
     *
     * ⚠️ 老 token（这次改动之前签发的）里没有 openid —— 退回按 userId 查，
     *    查不到才 401。至少不会静默地把一个老用户变成另一个人。
     */
    if (payload.openid) {
      user = await getOrCreateUserByOpenid(payload.openid)
    } else {
      const [found] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1)
      if (!found) return c.json({ ok: false, error: '用户不存在' }, 401)
      user = found
    }
  }

  // ⚠️ Hono 的 Variables 类型必须显式声明，否则 c.get('userId') 会报 TS2769
  c.set('userId', user.id)
  c.set('user', user)
  await next()
})

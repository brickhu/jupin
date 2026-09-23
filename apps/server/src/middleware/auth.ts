import type { Context } from 'hono'
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
 * ⚠️⚠️ 它同时是**全站唯一的注册点**，而这一点比「鉴权」本身更重要。
 *
 *    任何业务数据（分数、榜单、排期、录音）都挂在 user_id 上，
 *    所以**用户必须先在我们库里有一行，才谈得上使用业务数据**。
 *    这件事就由这里保证：把身份换成 users 那一行的是
 *    getOrCreateUserByOpenid() —— **没有就当场建**，之后才放行到路由。
 *    路由里拿到的 c.get('userId') 因此**一定**对应一条真实存在的行。
 *
 *    ⚠️ 「wx.login 是静默的」不等于「用户已经注册了」：
 *       wx.login 只解决「你是谁」（授权层），它只是 openid 的来源；
 *       「你在我们库里」是**这一层**发生的事。两者不是一回事。
 *
 *    ⚠️ 这条不变量最容易在一件很平常的事上破掉：加一个新路由、忘了挂鉴权。
 *       那一刻没有任何东西会报错 —— 接口能用、数据能出，
 *       只是谁都能读别人的。所以 index.ts 里每个 /api 业务前缀都有对应的
 *       app.use(..., authMiddleware)，并由 auth.test.ts 扫源码盯死。
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
 * ⭐ 后半句**已实测**（2026-09-22，从公网直连 dev 服务）：
 *    什么都不带 → 401；只带 x-wx-openid → 401；
 *    **同时带 x-wx-source + x-wx-openid → 仍然 401**。
 *    ⇒ 网关会把公网请求里的 x-wx-* 全部剥掉，这两条头只可能由 callContainer 注入。
 *    （顺带：这也意味着**没法**用 curl 从本机冒烟测任何受鉴权保护的接口 ——
 *      要测就得真机进小程序。）
 *
 * ⚠️ header 名大小写不敏感，Hono 的 c.req.header() 已做归一化，写小写即可。
 */
/**
 * 解析这次请求是谁；解析不出来时**返回原因，不抛也不响应**。
 *
 * ⚠️ 抽出来是为了让 authMiddleware（认不出就 401）与 optionalAuth
 *    （认不出就当匿名）共用**同一套**身份规则 —— 两套规则必然会分叉，
 *    而分叉的地方恰好是安全边界。
 */
type Resolved =
  | { ok: true; user: User }
  /** 什么都没带 */
  | { ok: false; reason: 'anonymous' }
  /** 带了 token 但验不过 */
  | { ok: false; reason: 'expired' }
  /** 老 token 里的 userId 已经不存在了 */
  | { ok: false; reason: 'gone' }

async function resolveUser(c: Context<{ Variables: Variables }>): Promise<Resolved> {
  // ---- 路径 ①：微信云托管内网调用 ----
  if (c.req.header('x-wx-source')) {
    // 资源复用场景没有 x-wx-openid，OpenID 在 x-wx-from-openid
    const openid = c.req.header('x-wx-openid') ?? c.req.header('x-wx-from-openid')
    if (openid) return { ok: true, user: await getOrCreateUserByOpenid(openid) }
  }

  // ---- 路径 ②：Bearer token ----
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return { ok: false, reason: 'anonymous' }
  const payload = verifyToken(header.slice(7))
  if (!payload) return { ok: false, reason: 'expired' }

  {

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
    if (payload.openid) return { ok: true, user: await getOrCreateUserByOpenid(payload.openid) }
    const [found] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1)
    return found ? { ok: true, user: found } : { ok: false, reason: 'gone' }
  }
}

const REASON_MESSAGE: Record<'anonymous' | 'expired' | 'gone', string> = {
  anonymous: '未登录',
  expired: '登录已过期',
  gone: '用户不存在',
}

export const authMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const id = await resolveUser(c)
  if (!id.ok) return c.json({ ok: false, error: REASON_MESSAGE[id.reason] }, 401)

  // ⚠️ Hono 的 Variables 类型必须显式声明，否则 c.get('userId') 会报 TS2769
  c.set('userId', id.user.id)
  c.set('user', id.user)
  await next()
})



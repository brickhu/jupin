import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { verifyToken } from '../lib/token'
import { getOrCreateUserByOpenid, type User } from '../services/user'

export interface Variables {
  userId: number
  user: User
}

/**
 * 鉴权 —— 两条入口，一个出口。
 *
 * ⭐⭐⭐ **凭据 ≠ 身份**（用户 2026-09 定：「不要拿 openid 当成我们库里的 userid，
 *    未来可能还有其他方式登录的用户」）：
 *      · **身份** = `users.id`（本库自增主键）。所有业务表、所有接口、
 *        客户端手里那个 id，都必须是它。
 *      · **凭据** = 微信 openid（将来还有手机号 / Apple sub…）。
 *        它只在这一个文件里、以及 lib/token.ts 的签名里出现 ——
 *        业务代码与响应体里**一律不许出现**（有 identity-guard.test.ts 盯着）。
 *      ⚠️ 所以本文件是**唯一**"凭据 → user.id"的翻译层：路由拿到的永远是
 *        `c.get('userId')`。将来加登录方式时，改的只是这一层。
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
 * ⚠️ 抽出来是为了让「认不出身份」只有一处判断 —— 两套规则必然会分叉，
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
     * ⭐⭐ token 里带凭据（现在就是 openid）时，**一律走「按凭据取或建」**，
     *    而不是「按 userId 查」。
     *
     * ⚠️ 两者的差别不是风格，是**能不能自愈**：
     *    · 按 userId 查：那一行数据没了，这张 token 就永远是废纸 ——
     *      用户被永久挡在门外，而他的身份（凭据）根本没变。
     *      清库、换环境、误删账号之后，每个人都要手动重启小程序才能恢复。
     *    · 按凭据取或建：行没了就再建一行，凭据还是同一个，对他而言**什么都没发生**。
     *
     * ⚠️ 这不会绕过封禁：被禁的账号 status='banned' 但仍然**存在**，
     *    getOrCreateUserByOpenid 会原样返回它，不会重建。只有真被删掉的行才会重建。
     *
     * ⚠️⚠️⚠️ **没有凭据的老 token：一律 401，绝不退回按 userId 查**（用户 2026-09 定）。
     *    理由不是洁癖，是**静默串号**：userId 是签发那一刻的行号，那一行可能已被删，
     *    而自增 id 会被复用 —— 按 userId 查会把请求认成**另一个人的账号**，
     *    表现为"我的成绩变成别人的"。宁可让他重新登录一次。
     *    ⇒ 凭据是身份的唯一入口；`userId` 只用于日志（见 lib/token.ts 的文件头）。
     *    ⚠️ 现在只有微信这一种凭据（openid）。将来加手机号 / Apple 登录时，
     *      这里改成"按凭据类型分发"即可，**业务代码一行都不用动** ——
     *      因为它拿到的一直是 `users.id`，不是 openid。
     */
    if (!payload.openid) return { ok: false, reason: 'anonymous' }
    return { ok: true, user: await getOrCreateUserByOpenid(payload.openid) }
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



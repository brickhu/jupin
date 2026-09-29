import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { verifyToken } from '../lib/token'
import { findUserByOpenid, type User } from '../services/user'

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
 * ⚠️⚠️ 它**不再建行**（2026-09 用户定：**注册不能做成自动的**）。
 *
 *    这里只回答一件事：**这次请求对应库里哪一行**。
 *      · 认得出凭据、行也在   → 放行，`c.get('userId')` 是 `users.id`；
 *      · 认得出凭据、行不在   → **未注册**，回 403 `NOT_REGISTERED`
 *                              （不是 401：401 的语义是"我认不出你是谁"）；
 *      · 认不出凭据           → 401（`AUTH_REQUIRED` / `AUTH_EXPIRED`）。
 *
 *    ⚠️⚠️ 建行的唯一入口是 `POST /api/auth/register`（用户在「加入句拼」页
 *       按下「确认加入」那一次），用的是 services/user.ts 的 `createUserByOpenid`。
 *       这里以前调的是 `getOrCreateUserByOpenid` —— "顺手取一下就建号"，
 *       于是**打开小程序就等于注册**，用户没有任何选择的机会。那个函数已删除，
 *       就是为了让"自动注册"在类型层面不可能再发生。
 *
 *    ⚠️ 「wx.login 是静默的」不等于「用户已经注册了」：
 *       wx.login 只解决「你是谁」（授权层），它只是 openid 的来源；
 *       「你在我们库里」是**用户自己决定加入**之后才发生的事。
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
/**
 * 解析这次请求的**凭据**（openid）—— 不查库、不建行。
 *
 * ⚠️⚠️ 只回答「你是谁」，不回答「你注册了没有」。注册接口
 *    （`POST /api/auth/register`）要的正是前半句：**建行之前**也得先认出人。
 *    鉴权中间件则在这之上再查一次库（见 resolveUser）。
 */
export async function resolveOpenid(c: Context): Promise<string | null> {
  // ---- 路径 ①：微信云托管内网调用 ----
  if (c.req.header('x-wx-source')) {
    // 资源复用场景没有 x-wx-openid，OpenID 在 x-wx-from-openid
    const openid = c.req.header('x-wx-openid') ?? c.req.header('x-wx-from-openid')
    if (openid) return openid
  }

  // ---- 路径 ②：Bearer token ----
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  const payload = verifyToken(header.slice(7))
  /**
   * ⚠️⚠️ **没有凭据的老 token：一律不认**（用户 2026-09 定）。
   *    理由不是洁癖，是**静默串号**：token 里的 userId 是签发那一刻的行号，
   *    那一行可能已被删，而自增 id 会被复用 —— 按 userId 查会把请求认成
   *    **另一个人的账号**，表现为"我的成绩变成别人的"。宁可让他重新登录一次。
   */
  return payload?.openid ?? null
}

type Resolved =
  | { ok: true; user: User }
  /** 什么都没带 */
  | { ok: false; reason: 'anonymous' }
  /** 带了 token 但验不过（含没有凭据的老 token） */
  | { ok: false; reason: 'expired' }
  /**
   * ⭐ 凭据认得出来，但**库里没有这一行** —— 即「还没加入句拼」。
   * ⚠️ 它不是错误，是本产品里**每个新用户的起点**（打开小程序 ≠ 注册）。
   */
  | { ok: false; reason: 'unregistered' }

async function resolveUser(c: Context<{ Variables: Variables }>): Promise<Resolved> {
  const openid = await resolveOpenid(c)

  if (!openid) {
    // 区分「什么都没带」与「带了但验不过」：只影响错误文案与 code（对界面是同一件事）
    const header = c.req.header('Authorization')
    return { ok: false, reason: header?.startsWith('Bearer ') ? 'expired' : 'anonymous' }
  }

  /**
   * ⚠️⚠️ **只查不建**。以前这里是 `getOrCreateUserByOpenid`：
   *    认得出 openid 就顺手建一行 —— 那等于"打开小程序即注册"。
   *    现在查不到就明确回「未注册」，由用户自己去加入页把这一行建出来。
   *    ⚠️ 副作用（有意的）：库被清空 / 换环境之后，老 token **不再自动重建账号**，
   *      用户需要再走一次「加入」—— 这正是"注册是显式动作"的必然结果。
   */
  const user = await findUserByOpenid(openid)
  if (!user) return { ok: false, reason: 'unregistered' }
  return { ok: true, user }
}

const REASON_MESSAGE: Record<'anonymous' | 'expired', string> = {
  anonymous: '未登录',
  expired: '登录已过期',
}

/**
 * ⭐ 未注册那一句 —— **不是错误，是一个状态**。
 * ⚠️ 端侧按 `code` 认它（见 miniprogram 的 lib/auth.ts）：收到它就说明
 *    "服务端认识我这个人，但我还没加入句拼"，据此画「加入」而不是报错。
 */
export const UNREGISTERED_MESSAGE = '还没有加入句拼'

/**
 * ⭐ **可选身份**：认得出就带上 userId，认不出就按 0（匿名）—— **绝不 401**。
 *
 * ⚠️ 给"公开但想知道看的人是谁"的接口用（现在只有 /api/leaderboards/growth）：
 *    首页那三块成长榜对所有人开放，但认得出我的时候应该把我那一行标出来。
 *    ⚠️ 之前那条路由读的是 `c.get('userId')`，而它挂在公开前缀上
 *      （守卫只管 /api/user/*）⇒ 拿到的一直是 undefined ⇒ `isMe` 恒 false、
 *      昵称永远是真实昵称 —— 类型注释和 service 注释都承诺了"自己显示「你」"。
 * ⚠️ 复用 resolveUser 而不是另写一套：认身份的规则必须只有一处（安全边界）。
 */
export const optionalAuthMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const id = await resolveUser(c)
  if (id.ok) {
    c.set('userId', id.user.id)
    c.set('user', id.user)
  } else {
    // ⚠️ 0 = 匿名（榜单里 `userId === 0` 永不命中任何人，所以谁都不会被标成「你」）
    c.set('userId', 0)
  }
  await next()
})

export const authMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const id = await resolveUser(c)
  if (!id.ok) {
    /**
     * ⭐⭐ **未注册 = 403 `NOT_REGISTERED`，不是 401**（2026-09 定）。
     *
     *    401 的语义是"我认不出你是谁"（没带凭据 / 凭据过期）—— 用户除了重新登录
     *    没有别的动作。而这里凭据是好的、人也是同一个人，只是**还没加入句拼**：
     *    他要做的是一个产品内的动作（去加入页），所以必须是一个**可区分**的状态。
     *    混成 401 的后果：客户端会把"还没注册"当成"登录失效"，走重登逻辑，然后
     *    重登一次仍然未注册 —— 转一圈还是不知道要干什么。
     */
    if (id.reason === 'unregistered') {
      return c.json(
        { ok: false, error: UNREGISTERED_MESSAGE, code: 'NOT_REGISTERED' },
        403,
      )
    }

    /**
     * ⭐ 401 带上**错误码**（2026-09 加）。
     *
     * ⚠️ 客户端 `lib/auth.ts` 一直按 `code` 判"服务端明确说认不出我"，
     *    但那个 code 一度两端都不存在 ⇒ 那条分支是死代码：
     *    token 失效时界面画的是「重新连接」而不是「加入」，用户点重试还是失败。
     * ⚠️ 两个 reason 都落在"你得重新登录一次"上（具体原因仍在 error 文案里，供人排查）。
     */
    return c.json(
      {
        ok: false,
        error: REASON_MESSAGE[id.reason],
        code: id.reason === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED',
      },
      401,
    )
  }

  // ⚠️ Hono 的 Variables 类型必须显式声明，否则 c.get('userId') 会报 TS2769
  c.set('userId', id.user.id)
  c.set('user', id.user)
  await next()
})



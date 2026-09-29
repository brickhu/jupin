import { eq } from 'drizzle-orm'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import { db } from '../db'
import { users } from '../db/schema'
import { signToken } from '../lib/token'
import { createUserByOpenid, findUserByOpenid } from '../services/user'
import { buildMeView } from '../services/me-view'
import { WxLoginError, code2session, hasAppSecret, syntheticIdentity } from '../services/wx-login'
import {
  normalizeAge,
  normalizeAvatarUrl,
  normalizeBio,
  normalizeGender,
  normalizeNickname,
} from './user'

export const authRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })
import type { Variables } from '../middleware/auth'
import { UNREGISTERED_MESSAGE, resolveOpenid } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  MeResponseSchema,
  TokenResponseSchema,
  errorResponse,
  okEnvelope,
} from '../openapi/schemas'


/**
 * 微信登录：wx.login 拿到的 code → openid → 签发 token。
 *
 * ⚠️⚠️ **这里不注册**（2026-09 用户定：注册不能做成自动的）。
 *    它只把凭据换成一张 token，**不碰 `users` 表**：
 *      · 已经加入过 → 顺带回 id / 昵称；
 *      · 还没加入   → `user: null`，token 里照样带凭据（userId=0 仅用于日志）。
 *    之后任何一个 `/api/user/*` 请求都会回 403 `NOT_REGISTERED`，端侧据此走加入页。
 *    建行的唯一入口是下面的 `POST /api/auth/register`。
 *
 * ⚠️ 部署到微信云托管后，走 callContainer 的请求**根本不需要走这个接口**：
 *    微信网关直接注入 x-wx-openid，见 middleware/auth.ts 路径①。
 *    本接口保留给「本地联调 / 公网访问」这条降级路径。
 */

/**
 * ⭐ 顺带把 **session_key** 落库。
 *
 * ⚠️ 为什么登录接口要管这件事：虚拟支付的**用户态签名**要 session_key，
 *    而它只能从 code2Session 拿。线上主通道是 callContainer（openid 由网关注入），
 *    那条路上**永远拿不到它** —— 所以两条路都要各自把能拿到的顺手存下来：
 *      · 这条（login）：本来就在换，顺带存
 *      · 另一条（/session）：专门为它准备的一次性刷新，见下
 * ⚠️ 它是敏感凭证：只写库、绝不下发、也不要打进日志。
 */
async function saveSessionKey(userId: number, sessionKey: string): Promise<void> {
  if (!sessionKey) return
  await db
    .update(users)
    .set({ sessionKey, sessionKeyAt: new Date() })
    .where(eq(users.id, userId))
}

/**
 * ⭐ 解析身份 —— 两条路：真实 code2Session，或（仅本地）合成一个稳定身份。
 *
 * ⚠️⚠️ 「本地换不到真 openid，只能用假的」是个**误解**：
 *    开发者工具里的 wx.login 拿到的 code 是**真的**，
 *    换回来的就是**开发者本人微信账号的 openid**（跟真机上是同一个）。
 *    所以判据是「配没配 appid/secret」，**不是** NODE_ENV。
 *
 *    之前按 NODE_ENV 分流、本地用合成 openid，代价很大：
 *    code 每次 wx.login 都变，而小程序每次启动都登录一次（app.ts 的 onLaunch）
 *    ⇒ 每次重新加载都换一个 openid = 每次都变成「刚注册、还没起过名字的新用户」。
 *    症状就是那句让人抓狂的话：「我明明加入过了，怎么又让我加入」。
 *    ——身份本来就在，是我们自己把它丢了，不是本地拿不到。
 */
async function resolveIdentity(
  code: string,
  as?: string,
): Promise<{ openid: string; sessionKey: string }> {
  if (hasAppSecret()) {
    const s = await code2session(code)
    return { openid: s.openid, sessionKey: s.sessionKey }
  }

  /**
   * 兜底：连 appid/secret 都没配（只想跑个离线 mock）→ 合成一个**稳定**的假身份。
   * ⚠️ 绝不能是生产环境：线上没配密钥应该直接失败，而不是给每个人发一个共享账号
   *    —— 那等于把所有人的成绩混在一条记录里。
   */
  if (process.env.NODE_ENV === 'production') {
    throw new WxLoginError('服务端未配置 WX_APPID / WX_SECRET，无法登录')
  }
  const s = syntheticIdentity(as)
  console.warn('[auth] 未配置 WX_APPID/WX_SECRET，使用合成的本地身份 ' + s.openid)
  return s
}

const authLoginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['身份'],
  summary: '登录：用 wx.login 的 code 换 token（本地/公网通道用）',
  request: { body: { content: { 'application/json': { schema: z.object({ code: z.string().optional(), as: z.string().optional() }) } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: TokenResponseSchema } },
      description: '成功',
    },
    400: errorResponse('缺少 code / code 无效'),
    401: errorResponse('code 换不到身份（登录失败）'),
    500: errorResponse('微信接口异常'),
  },
})

authRoutes.openapi(authLoginRoute, async (c) => {
  const { code, as } = await c.req.json<{ code?: string; as?: string }>().catch(() => ({}) as {
    code?: string
    as?: string
  })
  if (!code) return c.json({ ok: false, error: '缺少 code' }, 400)

  let identity: { openid: string; sessionKey: string }
  try {
    identity = await resolveIdentity(code, as)
  } catch (err) {
    const status = err instanceof WxLoginError ? 401 : 500
    return c.json({ ok: false, error: (err as Error).message }, status)
  }

  /**
   * ⚠️⚠️ **只查，不建**（见文件头）。未加入也照常发 token ——
   *    token 里带的是**凭据**（openid），userId 只是签发那一刻的行号（未加入时 0），
   *    鉴权只认凭据（见 lib/token.ts），所以这张 token 对后续请求是有效的，
   *    只是 `/api/user/*` 会回 403 NOT_REGISTERED，直到用户真的加入。
   */
  const user = await findUserByOpenid(identity.openid)
  // ⚠️ session_key 只能挂在一行上 —— 没注册就没有行可挂（下单本来也要求已加入）
  if (user) await saveSessionKey(user.id, identity.sessionKey)

  return c.json({
    ok: true,
    data: {
      token: signToken(user?.id ?? 0, identity.openid),
      user: user ? { id: user.id, nickname: user.nickname } : null,
    },
  }, 200)
})

/**
 * ⭐⭐⭐ **注册**（`POST /api/auth/register`）—— **全站唯一的建行入口**。
 *
 * 口径（用户 2026-09 定）：注册必须是**用户自己的一个动作**，
 * 不能是"打开小程序顺手建一行"。所以：
 *   · 它只在「加入句拼」页按下「确认加入」时被调用（见端侧 profile-form）；
 *   · 建行与保存资料在**同一个请求**里完成 —— 用户点了加入，他就既有了账号
 *     也有了榜上显示的名字；
 *   · 幂等：已经注册过的人再调它，只是更新资料，不会建出第二行。
 *
 * ⚠️ 它挂在 `/api/auth/*` 下（**公开前缀**），所以端点自己要先解析凭据
 *    （`resolveOpenid`）：认不出人 → 401；认得出但库里没有 → 那正是本次要做的事。
 *    ⚠️ 不能挂在 `/api/user/*` 下：那条路径上的 authMiddleware 会因为
 *      "还没注册"直接 403，注册请求根本到不了这里。
 */
const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['身份'],
  summary: '注册（唯一建行点）：加入句拼时创建账号并保存资料',
  description:
    '⚠️ 这是**唯一**会创建 `users` 行的接口。' +
    '只有用户在「加入句拼」页主动提交时才应调用它；' +
    '其它任何"顺手取用户"的路径都不得建行（见 middleware/auth.ts）。\n\n' +
    '幂等：已注册的人再调只更新资料。返回完整的「我是谁」，端侧据此直接落 store。',
  security: [{ userToken: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            nickname: z.string().nullish(),
            avatarUrl: z.string().nullish(),
            gender: z.enum(['male', 'female']).nullish(),
            age: z.number().nullish(),
            bio: z.string().nullish(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: MeResponseSchema } },
      description: '加入成功（已注册时是资料更新）',
    },
    400: errorResponse('昵称不能为空（1–32 个字符）'),
    401: errorResponse('没有可识别的身份（未登录）'),
    500: errorResponse('注册失败（建号/落库异常，请重试）'),
  },
})

authRoutes.openapi(registerRoute, async (c) => {
  const openid = await resolveOpenid(c)
  if (!openid) {
    return c.json({ ok: false, error: '未登录', code: 'AUTH_REQUIRED' }, 401)
  }

  const body = await c.req
    .json<{
      nickname?: string
      avatarUrl?: string
      gender?: string | null
      age?: number | string | null
      bio?: string | null
    }>()
    .catch(() => ({}) as Record<string, never>)

  const nickname = normalizeNickname(body.nickname)
  if (!nickname) return c.json({ ok: false, error: '昵称不能为空（1–32 个字符）' }, 400)

  /**
   * ⚠️ 三态语义与 `/api/user/profile` 一致：**键不存在 = 不改这一格**。
   *    加入页只发昵称（头像在注册之后单独传，因为上传路径要 uid）。
   */
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  const patch: {
    nickname: string
    avatarUrl?: string
    gender?: 'male' | 'female' | null
    age?: number | null
    bio?: string | null
  } = { nickname }
  const avatarUrl = normalizeAvatarUrl(body.avatarUrl)
  if (avatarUrl) patch.avatarUrl = avatarUrl
  if (has('gender')) patch.gender = normalizeGender(body.gender)
  if (has('age')) patch.age = normalizeAge(body.age)
  if (has('bio')) patch.bio = normalizeBio(body.bio)

  // ⭐ 建行（幂等）→ 写资料 → 回查最新那一行
  const created = await createUserByOpenid(openid)
  await db.update(users).set(patch).where(eq(users.id, created.id))

  /**
   * ⚠️ 回查走 services 的 findUserByOpenid，**不在路由里整行取 users** ——
   *    那条写法被 identity-guard.test.ts 盯着（凭据不许进响应体，整行最容易被顺手发出去）。
   */
  const fresh = await findUserByOpenid(openid)
  if (!fresh) return c.json({ ok: false, error: '注册失败，请重试' }, 500)

  return c.json({ ok: true, data: await buildMeView(fresh) }, 200)
})

/**
 * ⭐⭐ 专门刷新 session_key（**只为一个功能存在**：虚拟支付的用户态签名）。
 *
 * ⚠️ 为什么不能靠 /login：线上走 callContainer，用户**根本不会调 /login**
 *    （openid 由网关注入，天然已登录）。但没有 session_key 就下不了单，
 *    于是需要一个「我已经登录了，只是补一张票」的入口。
 *
 * ⚠️ 这个接口是公开的（在 /api/auth 下），但它**不能被用来冒充别人**：
 *    code 是微信发的、绑定这个用户的，换回来的 openid 就是他本人 ——
 *    所以它只能改**自己那一行**的 session_key。
 * ⚠️ 它不签发 token，也不回任何用户信息。
 */
const authSessionRoute = createRoute({
  method: 'post',
  path: '/session',
  tags: ['身份'],
  summary: '刷新 session_key（只为一个功能存在：虚拟支付的用户态签名）',
  request: { body: { content: { 'application/json': { schema: z.object({ code: z.string().optional() }) } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: okEnvelope(z.object({ refreshed: z.boolean() }).openapi('SessionRefreshResponse')) } },
      description: '成功',
    },
    400: errorResponse('缺少 code'),
    401: errorResponse('code 换不到身份（刷新失败）'),
    403: errorResponse('还没加入句拼（没有可挂 session_key 的账号）'),
    500: errorResponse('微信接口异常'),
    503: errorResponse('没配 AppSecret，刷不了'),
  },
})

authRoutes.openapi(authSessionRoute, async (c) => {
  const { code } = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string })
  if (!code) return c.json({ ok: false, error: '缺少 code' }, 400)

  let identity: { openid: string; sessionKey: string }
  try {
    identity = await resolveIdentity(code)
  } catch (err) {
    const status = err instanceof WxLoginError ? 401 : 500
    return c.json({ ok: false, error: (err as Error).message }, status)
  }
  if (!identity.sessionKey) {
    return c.json({ ok: false, error: '微信没有返回 session_key，请重新进入小程序再试' }, 503)
  }

  /**
   * ⚠️⚠️ **不再建行**：session_key 只能挂在已存在的账号上。
   *    它的唯一用途是虚拟支付的用户态签名，而支付本来就在 `/api/user/shop/*` 下
   *    （已注册才能到）。未注册的人来刷它没有意义 —— 明确回 NOT_REGISTERED，
   *    而不是顺手给他建一个号。
   */
  const user = await findUserByOpenid(identity.openid)
  if (!user) {
    return c.json({ ok: false, error: UNREGISTERED_MESSAGE, code: 'NOT_REGISTERED' }, 403)
  }
  await saveSessionKey(user.id, identity.sessionKey)
  return c.json({ ok: true, data: { refreshed: true } }, 200)
})
